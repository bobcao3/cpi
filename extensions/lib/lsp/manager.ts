/**
 * LSP manager (design §6.3, Layer 3).
 *
 * Owns the per-`(language, root)` session registry on `globalThis.__cpiLsp`
 * (state survives jiti reload; the facade is re-bound each load — same pattern
 * as `lib/footer.ts`). Session lifecycle lives in `session.ts`; this module is
 * the orchestration + public API.
 *
 * `ensureSession` is the SINGLE spawn point: idempotent on `(language, root)`,
 * restarts on `envPath` change or `force`, respawns when a session is `dead`.
 * It resolves even when provisioning fails (state `install-failed`) so producers
 * degrade instead of stalling (design §9/§13). `checkFile`/`lintText` open one
 * doc, await `publishDiagnostics` (bounded by `lintTimeoutMs`), close, return
 * normalized `Diagnostic[]`. `lintText` uses a synthetic `/tmp/cpi-lsp-<n>.<ext>`
 * doc with `rootUri=null` (the shuck inline path).
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { type Language, discoverProjectRoot, languageByPath } from "./discover.ts";
import { type Diagnostic } from "./diagnostics.ts";
import { getLspServerSpec } from "./registry.ts";
import { resolveBin } from "./provision.ts";
import { type LspConfig, loadLspConfig } from "../config.ts";
import {
  awaitReady,
  extForLanguage,
  makeSession,
  mergeSpawnEnv,
  sessionId,
  sessionLint,
  spawnSession,
  stopSession,
  toInfo,
  type LspSession,
  type SessionInfo,
  type SessionState,
} from "./session.ts";

interface LspState {
  sessions: Map<string, LspSession>;
  draining: boolean;
}

export interface EnsureOptions {
  envPath?: string;
  force?: boolean;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function getState(): LspState {
  const g = globalThis as unknown as { __cpiLsp?: LspState };
  if (!g.__cpiLsp) g.__cpiLsp = { sessions: new Map(), draining: false };
  return g.__cpiLsp;
}

/**
 * Resolve-or-install + spawn a worker for `(language, root)`. Idempotent:
 * returns the existing session unless `force`, an `envPath` change, or a `dead`
 * session triggers a restart. Never throws — install failure yields an
 * `install-failed` session the caller degrades on. The single spawn point.
 */
export async function ensureSession(
  language: Language,
  root: string,
  opts: EnsureOptions = {},
): Promise<LspSession> {
  const st = getState();
  const id = sessionId(language, root);
  const existing = st.sessions.get(id);
  const envChanged = existing ? existing.envPath !== opts.envPath : false;
  if (existing && !opts.force && !envChanged && existing.state !== "dead") return existing;
  if (existing) {
    st.sessions.delete(id);
    stopSession(existing);
  }
  const cfg = loadLspConfig();
  const spec = getLspServerSpec(language);
  const env = mergeSpawnEnv(opts.envPath);
  const resolved = await resolveBin(spec, env, {
    installTimeoutMs: cfg.installTimeoutMs,
    uv: cfg.tools.uv,
  });
  if (resolved.source === "install-failed") {
    const session = makeSession(
      id,
      language,
      root,
      opts.envPath,
      "",
      resolved.source,
      resolved.pathDir,
      "install-failed",
    );
    assert(!st.sessions.has(id), `ensureSession: session id collision ${id}`);
    st.sessions.set(id, session);
    return session;
  }
  const session = makeSession(
    id,
    language,
    root,
    opts.envPath,
    resolved.bin,
    resolved.source,
    resolved.pathDir,
    "starting",
  );
  spawnSession(session, spec, root, cfg);
  session.onDead = () => {
    getState().sessions.delete(session.id);
  };
  // assert: session-id uniqueness (design §13)
  assert(!st.sessions.has(id), `ensureSession: session id collision ${id}`);
  st.sessions.set(id, session);
  return session;
}

export async function checkFile(absPath: string): Promise<Diagnostic[]> {
  const language = languageByPath(absPath);
  if (!language) return [];
  const root = discoverProjectRoot(absPath, language);
  const cfg = loadLspConfig();
  const session = await ensureSession(language, root);
  if (session.state !== "ready") await awaitReady(session, cfg.startupTimeoutMs);
  if (session.state !== "ready") return [];
  const spec = getLspServerSpec(language);
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }
  const id = session.nextSeq++;
  return sessionLint(
    session,
    pathToFileURL(absPath).href,
    spec.languageId(absPath),
    text,
    absPath,
    id,
    cfg.lintTimeoutMs,
  );
}

export async function lintText(language: Language, text: string): Promise<Diagnostic[]> {
  // root="" -> rootUri=null inline session (shuck inline path, design §6.3)
  const session = await ensureSession(language, "");
  const cfg = loadLspConfig();
  if (session.state !== "ready") await awaitReady(session, cfg.startupTimeoutMs);
  if (session.state !== "ready") return [];
  const spec = getLspServerSpec(language);
  const seq = session.nextSeq++;
  const uri = `file:///tmp/cpi-lsp-${seq}.${extForLanguage(language)}`;
  return sessionLint(session, uri, spec.languageId(uri), text, "", seq, cfg.lintTimeoutMs);
}

export async function stop(target: string): Promise<void> {
  const st = getState();
  let session = st.sessions.get(target);
  if (!session) {
    const language = languageByPath(target);
    if (language) {
      const root = discoverProjectRoot(target, language);
      session = st.sessions.get(sessionId(language, root));
    }
  }
  if (!session) return;
  st.sessions.delete(session.id);
  stopSession(session);
}

export function findSession(language: Language, root: string): SessionInfo | undefined {
  const s = getState().sessions.get(sessionId(language, root));
  return s ? toInfo(s) : undefined;
}

export function list(): SessionInfo[] {
  return [...getState().sessions.values()].map(toInfo);
}

/** Idempotent/reentrant: drains every session, resolves pending `[]`. */
export async function disposeAll(): Promise<void> {
  const st = getState();
  if (st.draining) return;
  st.draining = true;
  try {
    const sessions = [...st.sessions.values()];
    st.sessions.clear();
    for (const s of sessions) stopSession(s);
  } finally {
    st.draining = false;
  }
}

export interface LspManager {
  ensureSession(language: Language, root: string, opts?: EnsureOptions): Promise<LspSession>;
  checkFile(absPath: string): Promise<Diagnostic[]>;
  lintText(language: Language, text: string): Promise<Diagnostic[]>;
  stop(target: string): Promise<void>;
  findSession(language: Language, root: string): SessionInfo | undefined;
  list(): SessionInfo[];
  disposeAll(): Promise<void>;
}

export function getLspManager(): LspManager {
  return {
    ensureSession,
    checkFile,
    lintText,
    stop,
    findSession,
    list,
    disposeAll,
  };
}

export type { SessionState };
