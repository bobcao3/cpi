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
 * doc with `rootUri=null` (the shuck inline path). `fullCheck` spawns the
 * language CLI (`tsc --noEmit -p <root>` / `pyrefly check` cwd=root), truncates
 * via pi's `truncateTail`, persists overflow to a session-dir log.
 *
 * Allowed pi imports (design §5 correction): `getAgentDir` (cache/log dirs) +
 * `truncateTail` (pure truncation). No tui / ExtensionAPI / session coupling.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { getAgentDir, truncateTail } from "@earendil-works/pi-coding-agent";
import { type Language, discoverProjectRoot, languageByPath } from "./discover.ts";
import { type Diagnostic } from "./diagnostics.ts";
import { getLspServerSpec } from "./registry.ts";
import { resolveBin, whichOnPath } from "./provision.ts";
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

const FULLCHECK_TIMEOUT_MS = 120_000;
const FULLCHECK_MAX_BUFFER = 10 * 1024 * 1024;

interface LspState {
  sessions: Map<string, LspSession>;
  draining: boolean;
}

export interface EnsureOptions {
  envPath?: string;
  force?: boolean;
}

export interface FullCheckResult {
  text: string;
  logPath?: string;
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

const execFileAsync = promisify(execFile);

export async function fullCheck(language: Language, root: string): Promise<FullCheckResult> {
  const cfg = loadLspConfig();
  const spec = getLspServerSpec(language);
  if (!spec.supportsFullPackageCheck || !spec.fullCheckCommand) {
    return { text: `(fullCheck: not supported for ${language})` };
  }
  const session = await ensureSession(language, root);
  const fc = spec.fullCheckCommand(session.bin, root);
  // tsc resolves from dirname(bin) (the env's node_modules/.bin); an env-PROVIDED
  // server (source="env", no envDir) may lack tsc there — fall back to tsc on
  // PATH, else skip with a note. (RISK flagged for Layer 4.)
  let cmd = fc.cmd;
  if (!existsSync(cmd)) {
    const onPath = whichOnPath(basename(cmd), mergeSpawnEnv(session.envPath));
    if (!onPath) {
      return {
        text: `(fullCheck skipped: ${basename(cmd)} not found — env-provided server has no bundled checker)`,
      };
    }
    cmd = onPath;
  }
  const env = mergeSpawnEnv(session.envPath);
  let out: string;
  try {
    const r = await execFileAsync(cmd, fc.args, {
      cwd: fc.cwd ?? root,
      maxBuffer: FULLCHECK_MAX_BUFFER,
      env,
      timeout: FULLCHECK_TIMEOUT_MS,
    });
    out = (r.stdout ?? "") + (r.stderr ?? "");
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    out = (e.stdout ?? "") + (e.stderr ?? "");
    if (!out) out = String(e.message ?? err);
  }
  return truncateCheckOutput(out, cfg, session.id);
}

function truncateCheckOutput(out: string, cfg: LspConfig, sid: string): FullCheckResult {
  const snap = truncateTail(out, { maxLines: cfg.checkMaxLines, maxBytes: cfg.checkMaxBytes });
  if (!snap.truncated) return { text: snap.content || "(no output)" };
  const logDir = join(getAgentDir(), "lsp", sid);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `fullcheck-${Date.now()}.log`);
  writeFileSync(logPath, out);
  const start = snap.totalLines - snap.outputLines + 1;
  let text = snap.content + `\n\n[L${start}-${snap.totalLines}/${snap.totalLines}`;
  if (snap.truncatedBy === "bytes") text += ` (${cfg.checkMaxBytes}B cap)`;
  text += ` full: ${logPath}]`;
  return { text, logPath };
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
  fullCheck(language: Language, root: string): Promise<FullCheckResult>;
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
    fullCheck,
    stop,
    findSession,
    list,
    disposeAll,
  };
}

export type { SessionState };
