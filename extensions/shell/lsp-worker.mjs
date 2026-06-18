/**
 * Shuck LSP worker — dedicated Worker thread.
 * Owns shuck server child process, all LSP stdio I/O.
 *
 * Protocol (main → worker): { type: "lint", id, command } | { type: "dispose" }
 * Protocol (worker → main): { type: "ready" } | { type: "result", id, diagnostics } | { type: "error", id, message }
 */

import { spawn } from "node:child_process";
import { parentPort, workerData } from "node:worker_threads";

const TIMEOUT = 10_000, shuckPath = workerData.shuckPath;
let proc = null, initialized = false, buffer = "", nextId = 1, nextDoc = 1, initP = null;
const reqs = new Map(), diags = new Map();

function onData(data) {
  buffer += data.toString("utf8");
  for (;;) {
    const he = buffer.indexOf("\r\n\r\n");
    if (he === -1) break;
    const m = buffer.slice(0, he).match(/Content-Length:\s*(\d+)/i);
    if (!m) { buffer = buffer.slice(he + 4); continue; }
    const len = +m[1], bs = he + 4;
    if (buffer.length < bs + len) break;
    try {
      const msg = JSON.parse(buffer.slice(bs, bs + len));
      if (msg.id !== undefined && (msg.result !== undefined || msg.error)) {
        const p = reqs.get(msg.id); if (p) { reqs.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); }
      } else if (msg.method === "textDocument/publishDiagnostics") {
        const cb = diags.get(msg.params?.uri); if (cb) { diags.delete(msg.params?.uri); cb(msg.params?.diagnostics ?? []); }
      }
    } catch {}
    buffer = buffer.slice(bs + len);
  }
}

function send(msg) {
  if (!proc?.stdin?.writable) return;
  const j = JSON.stringify(msg);
  try { proc.stdin.write(`Content-Length: ${Buffer.byteLength(j)}\r\n\r\n${j}`); } catch {}
}

const sendNotif = (method, params) => send({ jsonrpc: "2.0", method, params });

parentPort.on("message", async (msg) => {
  if (msg.type === "dispose") { proc?.kill(); process.exit(0); }
  if (msg.type !== "lint") return;
  try {
    // Ensure server ready
    if (initP) { try { await initP; } catch { initP = null; } }
    if (!(initialized && proc && !proc.killed && proc.stdin?.writable)) {
      initP = (async () => {
        initialized = false;
        proc = spawn(shuckPath, ["server", "--isolated"], { stdio: ["pipe", "pipe", "pipe"] });
        proc.stdin?.on("error", (e) => { if (e.code !== "EPIPE") console.warn("[shuck-worker] stdin:", e); });
        proc.stdout?.on("data", onData);
        proc.stderr?.on("data", (d) => { const m = d.toString().trim(); if (m) console.debug("[shuck-worker] stderr:", m); });
        proc.on("exit", (code) => {
          proc = null; initialized = false; initP = null;
          reqs.forEach((p) => p.reject(new Error(`server exited (${code})`))); reqs.clear();
          diags.forEach((cb) => cb([])); diags.clear();
        });
        await new Promise((resolve, reject) => {
          const id = nextId++; reqs.set(id, { resolve, reject });
          send({ jsonrpc: "2.0", id, method: "initialize", params: {
            processId: process.pid, rootUri: null,
            capabilities: { textDocument: { synchronization: { didOpen: true, didChange: true, didClose: true } } },
          } });
        });
        sendNotif("initialized", {});
        initialized = true;
      })();
      await initP;
    }
    if (!proc) { parentPort.postMessage({ type: "result", id: msg.id, diagnostics: [] }); return; }

    // Lint
    const uri = `file:///tmp/pi-shuck-lsp-${nextDoc++}.sh`;
    const raw = await new Promise((resolve) => {
      let done = false;
      const finish = (d) => { if (done) return; done = true; clearTimeout(t); diags.delete(uri); sendNotif("textDocument/didClose", { textDocument: { uri } }); resolve(d); };
      const t = setTimeout(() => finish([]), TIMEOUT);
      diags.set(uri, finish);
      sendNotif("textDocument/didOpen", { textDocument: { uri, languageId: "bash", version: 1, text: msg.command } });
    });
    const diagnostics = raw.map((d) => ({
      code: d.code, severity: d.severity === 1 ? "error" : d.severity <= 3 ? "warning" : "hint", message: d.message, filename: "",
      location: { row: d.range.start.line + 1, column: d.range.start.character + 1 },
      end_location: { row: d.range.end.line + 1, column: d.range.end.character + 1 },
    }));
    parentPort.postMessage({ type: "result", id: msg.id, diagnostics });
  } catch (e) {
    parentPort.postMessage({ type: "error", id: msg.id, message: e.message });
  }
});

parentPort.postMessage({ type: "ready" });
