/**
 * LSP manager: session registry lives on `globalThis.__cpiLsp` (survives
 * jiti reload; the facade re-binds each load). `ensureSession` is the single
 * spawn point — idempotent, never throws; provisioning failure yields an
 * `install-failed` session the caller degrades on.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  type Language,
  discoverProjectRoot,
  languageByPath,
} from "./discover.ts";
import { type Diagnostic } from "./diagnostics.ts";
import { getLspServerSpec } from "./registry.ts";
import { resolveBin } from "./provision.ts";
import { loadLspConfig } from "../config.ts";
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
  inflight: Map<string, Promise<LspSession>>;
  draining: boolean;
}

export interface EnsureOptions {
  envPath?: string;
  force?: boolean;
}

export interface LintTextOptions {
  extension?: string;
}

function getState(): LspState {
  const g = globalThis as unknown as { __cpiLsp?: LspState };
  if (!g.__cpiLsp)
    g.__cpiLsp = { sessions: new Map(), inflight: new Map(), draining: false };
  return g.__cpiLsp;
}

/**
 * Idempotent and concurrency-safe: reuses the live session unless `force`,
 * an `envPath` change, or `dead`; concurrent spawns for one `(language,
 * root)` serialize on `inflight`.
 */
export async function ensureSession(
  language: Language,
  root: string,
  opts: EnsureOptions = {},
): Promise<LspSession> {
  const st = getState();
  const id = sessionId(language, root);
  for (;;) {
    const existing = st.sessions.get(id);
    // Only an explicitly-supplied changed envPath restarts the session.
    const envChanged =
      existing && opts.envPath !== undefined
        ? existing.envPath !== opts.envPath
        : false;
    if (existing && !opts.force && !envChanged && existing.state !== "dead")
      return existing;
    const pending = st.inflight.get(id);
    if (!pending) break;
    await pending.catch(() => {});
  }
  const p = provisionSession(st, id, language, root, opts).finally(() =>
    st.inflight.delete(id),
  );
  st.inflight.set(id, p);
  return p;
}

async function provisionSession(
  st: LspState,
  id: string,
  language: Language,
  root: string,
  opts: EnsureOptions,
): Promise<LspSession> {
  const existing = st.sessions.get(id);
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
  const installFailed = (): LspSession =>
    makeSession(
      id,
      language,
      root,
      opts.envPath,
      "",
      [],
      "install-failed",
      resolved.pathDir,
      "install-failed",
    );
  if (resolved.source === "install-failed") {
    const failed = installFailed();
    st.sessions.set(id, failed);
    return failed;
  }
  const session = makeSession(
    id,
    language,
    root,
    opts.envPath,
    resolved.bin,
    resolved.args ?? [],
    resolved.source,
    resolved.pathDir,
    "starting",
  );
  spawnSession(session, spec, root, cfg);
  session.onDead = () => {
    getState().sessions.delete(session.id);
  };
  // Draining means disposeAll won the race: don't publish — stop and degrade.
  if (st.draining) {
    stopSession(session);
    return installFailed();
  }
  st.sessions.set(id, session);
  return session;
}

export async function checkFile(absPath: string): Promise<Diagnostic[]> {
  const language = languageByPath(absPath);
  if (!language) return [];
  const root = discoverProjectRoot(absPath, language);
  const cfg = loadLspConfig();
  const session = await ensureSession(language, root);
  if (session.state !== "ready")
    await awaitReady(session, cfg.startupTimeoutMs);
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

export async function lintText(
  language: Language,
  text: string,
  opts: LintTextOptions = {},
): Promise<Diagnostic[]> {
  // Empty root creates an inline null-root session.
  const session = await ensureSession(language, "");
  const cfg = loadLspConfig();
  if (session.state !== "ready")
    await awaitReady(session, cfg.startupTimeoutMs);
  if (session.state !== "ready") return [];
  const spec = getLspServerSpec(language);
  const seq = session.nextSeq++;
  const extension = (opts.extension ?? extForLanguage(language)).replace(
    /^\./,
    "",
  );
  const uri = `file:///tmp/cpi-lsp-${seq}.${extension}`;
  return sessionLint(
    session,
    uri,
    spec.languageId(uri),
    text,
    "",
    seq,
    cfg.lintTimeoutMs,
  );
}

export async function stop(target: string): Promise<void> {
  const st = getState();
  let session = st.sessions.get(target);
  let id = target;
  if (!session) {
    const language = languageByPath(target);
    if (language) {
      const root = discoverProjectRoot(target, language);
      id = sessionId(language, root);
      session = st.sessions.get(id);
    }
  }
  if (!session) {
    const pending = st.inflight.get(id);
    if (pending) {
      await pending.catch(() => {});
      session = st.sessions.get(id);
    }
  }
  if (!session) return;
  st.sessions.delete(session.id);
  stopSession(session);
}

export function findSession(
  language: Language,
  root: string,
): SessionInfo | undefined {
  const s = getState().sessions.get(sessionId(language, root));
  return s ? toInfo(s) : undefined;
}

export function list(): SessionInfo[] {
  return [...getState().sessions.values()].map(toInfo);
}

export async function disposeAll(): Promise<void> {
  const st = getState();
  if (st.draining) return;
  st.draining = true;
  try {
    const sessions = [...st.sessions.values()];
    st.sessions.clear();
    for (const s of sessions) stopSession(s);
    const pending = [...st.inflight.values()];
    if (pending.length) await Promise.allSettled(pending);
  } finally {
    st.draining = false;
  }
}

export interface LspManager {
  ensureSession(
    language: Language,
    root: string,
    opts?: EnsureOptions,
  ): Promise<LspSession>;
  checkFile(absPath: string): Promise<Diagnostic[]>;
  lintText(
    language: Language,
    text: string,
    opts?: LintTextOptions,
  ): Promise<Diagnostic[]>;
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
