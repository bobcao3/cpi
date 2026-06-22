/**
 * Generic JSON-RPC stdio LSP worker (design §6.6, Layer 3).
 *
 * One Worker thread owns ONE language server child process and all its LSP
 * stdio I/O (Content-Length framing). Generalizes `shell/lsp-worker.mjs`: the
 * server spawn directive comes from `workerData`, so the same worker drives
 * shuck, tsserver, and pyrefly. Pure node — no pi import.
 *
 * Protocol (main -> worker):
 *   { type:"lint", id, uri, languageId, text, file }
 *   { type:"dispose" }
 * Protocol (worker -> main):
 *   { type:"ready", ok:boolean, error? }
 *   { type:"result", id, diagnostics: Diagnostic[] }
 *   { type:"dead" }
 *
 * `lint` = didOpen(uri,languageId,text) -> await publishDiagnostics (bounded by
 * `lintTimeoutMs`) -> didClose -> return normalized diagnostics. `file` is the
 * caller-chosen absolute path ("" for synthetic inline docs), stamped onto each
 * diagnostic verbatim (the worker never parses URIs).
 *
 * Explicit limits (design §13): 16 MiB recv buffer; `for(;;)` read loop breaks
 * on an incomplete frame and resets the buffer on a breach; `Content-Length`
 * parse is asserted; the server is `initialize`d before any `lint` is posted.
 */

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";

const RECV_BUF_MAX = 16 * 1024 * 1024;
const d = workerData;
const spawnDir = d.spawn;
const initOptions = d.initOptions;
const source = d.source;
const startupTimeoutMs = d.startupTimeoutMs;
const lintTimeoutMs = d.lintTimeoutMs;
const rootUri = d.rootUri;
const diagnosticMode = d.diagnosticMode || "push";
const logPath = spawnDir.logPath || null;

let proc = null;
let initialized = false;
let buffer = "";
let nextId = 1;
const reqs = new Map();
const diags = new Map();

function openLog() {
  if (!logPath) return;
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {}
}

function log(tag, msg) {
  if (!logPath) return;
  try {
    appendFileSync(logPath, `${new Date().toISOString()} [${source}] ${tag}: ${msg}\n`, "utf8");
  } catch {}
}

function post(msg) {
  parentPort.postMessage(msg);
}

function withTimeout(ms, p) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function send(msg) {
  if (!proc || proc.killed || !proc.stdin || !proc.stdin.writable) return;
  const j = JSON.stringify(msg);
  try {
    proc.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`);
  } catch {
    /* EPIPE: server gone; exit handler will surface dead */
  }
}

function sendReq(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    reqs.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

function sendNotif(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function handle(msg) {
  if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
    const p = reqs.get(msg.id);
    if (p) {
      reqs.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
    }
    return;
  }
  if (msg.method === "textDocument/publishDiagnostics") {
    const uri = msg.params && msg.params.uri;
    const cb = diags.get(uri);
    if (cb) {
      diags.delete(uri);
      cb(msg.params.diagnostics ?? []);
    }
  }
  // other notifications (window/logMessage, etc.) are ignored
}

function onData(data) {
  buffer += data.toString("utf8");
  if (buffer.length > RECV_BUF_MAX) {
    // breach: a single framed response exceeded the budget; reset and let the
    // server exit handler (or next lint's timeout) surface the failure.
    log("lsp-worker", "recv buffer breach (>16MiB); resetting");
    buffer = "";
    return;
  }
  for (;;) {
    const he = buffer.indexOf("\r\n\r\n");
    if (he === -1) break; // incomplete header: wait for more
    const m = buffer.slice(0, he).match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      buffer = buffer.slice(he + 4);
      continue;
    } // skip non-LSP header block
    const len = Number(m[1]);
    // assert: Content-Length parsed as a finite positive integer (design §13)
    if (!Number.isFinite(len) || len <= 0) {
      log("lsp-worker", "malformed Content-Length; resetting");
      buffer = "";
      return;
    }
    const bs = he + 4;
    if (buffer.length < bs + len) break; // incomplete body: wait for more
    let msg;
    try {
      msg = JSON.parse(buffer.slice(bs, bs + len));
    } catch {
      buffer = buffer.slice(bs + len);
      continue;
    }
    handle(msg);
    buffer = buffer.slice(bs + len);
  }
}

function severityName(s) {
  return s === 1 ? "error" : s === 2 ? "warning" : s === 3 ? "info" : "hint";
}

function toDiag(d, file) {
  const r = d.range || {};
  const start = r.start || {};
  const end = r.end || {};
  return {
    severity: severityName(d.severity),
    code: d.code !== undefined && d.code !== null ? String(d.code) : undefined,
    message: typeof d.message === "string" ? d.message : "",
    source,
    file,
    startLine: (start.line ?? 0) + 1,
    startCol: (start.character ?? 0) + 1,
    endLine: (end.line ?? 0) + 1,
    endCol: (end.character ?? 0) + 1,
  };
}

async function start() {
  openLog();
  try {
    proc = spawn(spawnDir.cmd, spawnDir.args, {
      cwd: spawnDir.cwd,
      env: spawnDir.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    post({
      type: "ready",
      ok: false,
      error: `spawn failed: ${String((err && err.message) || err)}`,
    });
    process.exit(1);
  }
  proc.stdin.on("error", (e) => {
    if (e.code !== "EPIPE") log("lsp-worker", `stdin: ${e.message}`);
  });
  proc.stdout.on("data", onData);
  proc.stderr.on("data", (b) => {
    const m = b.toString().trim();
    if (m) log("stderr", m);
  });
  proc.on("exit", (code) => {
    log("lsp-worker", `server exited (${code})`);
    proc = null;
    initialized = false;
    reqs.forEach((p) => p.reject(new Error(`server exited (${code})`)));
    reqs.clear();
    diags.forEach((cb) => cb([]));
    diags.clear();
    post({ type: "dead" });
  });
  try {
    await withTimeout(
      startupTimeoutMs,
      sendReq("initialize", {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didClose: true },
            publishDiagnostics: {},
            ...(diagnosticMode === "pull"
              ? { diagnostic: { interFileDependencies: false, workspaceDiagnostics: false } }
              : {}),
          },
        },
        initializationOptions: initOptions,
      }),
    );
    sendNotif("initialized", {});
    initialized = true;
    post({ type: "ready", ok: true });
  } catch (err) {
    post({ type: "ready", ok: false, error: String((err && err.message) || err) });
    try {
      proc.kill();
    } catch {}
    process.exit(1);
  }
}

parentPort.on("message", (msg) => {
  if (msg.type === "dispose") {
    try {
      proc && proc.kill();
    } catch {}
    process.exit(0);
  }
  if (msg.type !== "lint") return;
  if (!initialized) {
    post({ type: "result", id: msg.id, diagnostics: [] });
    return;
  }
  const uri = msg.uri;
  const file = msg.file;
  (async () => {
    const raw = await new Promise((resolve) => {
      let done = false;
      const finish = (dd) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        diags.delete(uri);
        sendNotif("textDocument/didClose", { textDocument: { uri } });
        resolve(dd);
      };
      const t = setTimeout(() => finish([]), lintTimeoutMs);
      sendNotif("textDocument/didOpen", {
        textDocument: { uri, languageId: msg.languageId, version: 1, text: msg.text },
      });
      if (diagnosticMode === "pull") {
        sendReq("textDocument/diagnostic", { textDocument: { uri } }).then(
          (report) => finish(report?.items ?? []),
          () => finish([]),
        );
      } else {
        diags.set(uri, finish);
      }
    });
    const diagnostics = (raw ?? []).map((dd) => toDiag(dd, file));
    post({ type: "result", id: msg.id, diagnostics });
  })().catch(() => post({ type: "result", id: msg.id, diagnostics: [] }));
});

start();
