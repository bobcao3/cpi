/**
 * LSP session lifecycle (Layer 3, extracted from manager.ts to respect the
 * 397-src/355-AST budget). One {@link LspSession} owns one Worker thread and
 * one language server process (1:1:1 isolation, design §13). Pure node except
 * `getToolEnv` (shell/tools) for the spawn env.
 *
 * The worker is spawned in {@link spawnSession}; `ready` resolves once the
 * `initialize` handshake completes (or `false` on failure/exit). `sessionLint`
 * posts one didOpen, awaits `publishDiagnostics` (bounded by `lintTimeoutMs`),
 * didCloses, and returns normalized `Diagnostic[]`. `stopSession` is idempotent
 * and reentrant: drains pending, posts dispose, nulls the worker.
 */

import { Worker } from "node:worker_threads";
import { mkdirSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Language } from "./discover.ts";
import { type Diagnostic } from "./diagnostics.ts";
import { type LspServerSpec } from "./registry.ts";
import { type LspConfig } from "../config.ts";
import { getToolEnv } from "../../shell/tools.ts";
import { parseDotEnv } from "../dotenv.ts";
import { resolveCwdPath } from "../cwd.ts";

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "worker.mjs");
const MAX_OPEN_DOCS = 64;

export type SessionState = "starting" | "ready" | "dead" | "install-failed";

export interface LspSession {
  id: string;
  language: Language;
  projectRoot: string;
  envPath?: string;
  bin: string;
  source: string;
  pathDir?: string;
  worker: Worker | null;
  ready: Promise<boolean>;
  readyResolve: (v: boolean) => void;
  state: SessionState;
  nextSeq: number;
  openDocs: number;
  pending: Map<number, (d: Diagnostic[]) => void>;
  onDead?: () => void;
}

export interface SessionInfo {
  id: string;
  language: Language;
  projectRoot: string;
  state: SessionState;
  source: string;
  bin: string;
  envPath?: string;
}

export type WorkerMsg =
  | { type: "ready"; ok: boolean; error?: string }
  | { type: "result"; id: number; diagnostics: Diagnostic[] }
  | { type: "dead" };

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function sessionId(language: Language, root: string): string {
  return `${language}:${root}`;
}

export function sourceName(language: Language): string {
  return language === "typescript" ? "tsserver" : language === "python" ? "pyrefly" : "shuck";
}

export function extForLanguage(language: Language): string {
  return language === "typescript" ? ".ts" : language === "python" ? ".py" : ".sh";
}

export function mergeSpawnEnv(envPath?: string): NodeJS.ProcessEnv {
  const env = getToolEnv();
  if (envPath) {
    for (const [k, v] of Object.entries(parseDotEnv(resolveCwdPath(envPath)))) env[k] = v;
  }
  return env;
}

function buildSpawnEnv(base: NodeJS.ProcessEnv, pathDir?: string): NodeJS.ProcessEnv {
  if (!pathDir) return { ...base };
  const env = { ...base };
  const key = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
  env[key] = [pathDir, env[key] ?? ""].join(delimiter);
  return env;
}

export function makeSession(
  id: string,
  language: Language,
  root: string,
  envPath: string | undefined,
  bin: string,
  source: string,
  pathDir: string | undefined,
  state: SessionState,
): LspSession {
  const session: LspSession = {
    id,
    language,
    projectRoot: root,
    envPath,
    bin,
    source,
    pathDir,
    worker: null,
    ready: Promise.resolve(false),
    readyResolve: () => {},
    state,
    nextSeq: 1,
    openDocs: 0,
    pending: new Map(),
  };
  if (state !== "install-failed") {
    session.ready = new Promise<boolean>((resolve) => {
      session.readyResolve = resolve;
    });
  }
  return session;
}

function drainPending(session: LspSession, val: Diagnostic[]): void {
  const ps = [...session.pending.values()];
  session.pending.clear();
  for (const p of ps) p(val);
}

function markDead(session: LspSession): void {
  if (session.state === "starting" || session.state === "ready") {
    session.state = "dead";
    drainPending(session, []);
    const cb = session.onDead;
    session.onDead = undefined;
    if (cb) cb();
  }
}

function onWorkerFail(session: LspSession): void {
  markDead(session);
  session.readyResolve(false);
}

function onWorkerMsg(session: LspSession, msg: WorkerMsg): void {
  if (msg.type === "ready") {
    if (msg.ok) {
      session.state = "ready";
    } else {
      markDead(session);
    }
    session.readyResolve(msg.ok);
  } else if (msg.type === "dead") {
    onWorkerFail(session);
  } else if (msg.type === "result") {
    const p = session.pending.get(msg.id);
    if (p) {
      session.pending.delete(msg.id);
      p(msg.diagnostics ?? []);
    }
  }
}

export function spawnSession(
  session: LspSession,
  spec: LspServerSpec,
  root: string,
  cfg: LspConfig,
): void {
  const rootUri = root ? pathToFileURL(root).href : null;
  const logPath = join(getAgentDir(), "lsp_logs", `${session.id}.log`);
  mkdirSync(dirname(logPath), { recursive: true });
  const directive = spec.serverCommand(session.bin, root);
  const spawnEnv = buildSpawnEnv(mergeSpawnEnv(session.envPath), session.pathDir);
  const worker = new Worker(WORKER_PATH, {
    workerData: {
      spawn: {
        cmd: directive.cmd,
        args: directive.args,
        cwd: directive.cwd ?? root,
        env: spawnEnv,
        logPath,
      },
      initOptions: spec.initOptions,
      source: sourceName(session.language),
      startupTimeoutMs: cfg.startupTimeoutMs,
      lintTimeoutMs: cfg.lintTimeoutMs,
      rootUri,
    },
  });
  session.worker = worker;
  worker.on("message", (msg: WorkerMsg) => onWorkerMsg(session, msg));
  worker.on("error", () => onWorkerFail(session));
  worker.on("exit", () => onWorkerFail(session));
}

export function sessionLint(
  session: LspSession,
  uri: string,
  languageId: string,
  text: string,
  file: string,
  id: number,
  timeoutMs: number,
): Promise<Diagnostic[]> {
  // assert: ready before posting (design §13)
  if (session.state !== "ready" || !session.worker) return Promise.resolve([]);
  assert(session.openDocs < MAX_OPEN_DOCS, `too many open docs: ${session.openDocs}`);
  session.openDocs++;
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      session.pending.delete(id);
      session.openDocs = Math.max(0, session.openDocs - 1);
      resolve([]);
    }, timeoutMs);
    session.pending.set(id, (dd: Diagnostic[]) => {
      clearTimeout(t);
      session.openDocs = Math.max(0, session.openDocs - 1);
      resolve(dd);
    });
    session.worker!.postMessage({ type: "lint", id, uri, languageId, text, file });
  });
}

export function stopSession(session: LspSession): void {
  markDead(session);
  const w = session.worker;
  session.worker = null;
  session.readyResolve(false);
  if (w) {
    try {
      w.postMessage({ type: "dispose" });
    } catch {
      /* worker already gone */
    }
  }
}

export function awaitReady(session: LspSession, startupTimeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, startupTimeoutMs);
    session.ready.then(
      (v: boolean) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(false);
        }
      },
    );
  });
}

export function toInfo(s: LspSession): SessionInfo {
  return {
    id: s.id,
    language: s.language,
    projectRoot: s.projectRoot,
    state: s.state,
    source: s.source,
    bin: s.bin,
    envPath: s.envPath,
  };
}
