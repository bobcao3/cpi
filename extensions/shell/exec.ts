/**
 * Shell execution engine — spawns each command through `sh-monitor` (a detached
 * nohup-style supervisor) so the child's stdout/stderr pipe is owned by the
 * supervisor, never by pi. pi drives it over the framed socket (control +
 * zero-copy live data). Benefits vs. the old direct-pipe path:
 *
 *   - `sh_detach`: a background PID can be released to run untracked and
 *     survive pi's own exit (no SIGPIPE — pi never held the child's pipe).
 *   - controlled-mode streaming is preserved (live DATA frames → onPartial).
 *   - the log file is the durable source of truth; acc is just live preview.
 *
 * Public interface preserved: runShell, signalChild, silenceChild, detachChild,
 * killAll, getters, buildOutputText, completion hook.
 */

import { rm, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { truncateOutput, type OutputTruncation } from "../lib/output-truncate.ts";
import {
  getActiveRepeats,
  hasActiveRepeats,
  killAllRepeats,
  setRepeatCompletionHook,
  setRepeatScopeGetter,
  signalRepeat,
} from "./repeat.ts";
import {
  launchMonitor,
  type MonitorClient,
  ResumeClient,
  writeResumeRecord,
  writeCompletedRecord,
  readResumeRecords,
  removeResumeRecord,
} from "./monitor.ts";

export type { OutputTruncation };

export interface ShellTunables {
  previewMaxBytes: number;
  maxAcc: number;
  updateMs: number;
}

interface BackgroundChild {
  id: string;
  pid: number;
  command: string;
  describe?: string;
  client: MonitorClient | ResumeClient;
  logPath: string;
  acc: string;
  decoder: StringDecoder;
  exitCode: number | null;
  done: boolean;
  signaled?: boolean;
  bytesEmitted: number;
  linesEmitted: number;
  colBytes: number;
  sessDir?: string;
  sessScope?: string;
}

export interface OutputCursor {
  line: number;
  column: number;
  bytes: number;
}

export interface ShResult {
  id: string | null;
  status: "completed" | "running";
  exitCode: number | null;
  text: string;
  fullOutputPath?: string;
  cursor?: OutputCursor;
}

export type CompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "stopped" | "breach",
  log?: { path: string; startLine?: number; endLine?: number },
) => void;

const bg = new Map<string, BackgroundChild>();
let completionHook: CompletionHook | undefined;

let currentScope: string | undefined;
export const setCurrentScope = (scope: string | undefined): void => {
  currentScope = scope;
};
setRepeatScopeGetter(() => currentScope);

export const setCompletionHook = (fn: CompletionHook) => {
  completionHook = fn;
  setRepeatCompletionHook(fn);
};

export async function buildOutputText(
  acc: string,
  opts: {
    persistIfTruncated?: boolean;
    emptyText?: string;
    logPath?: string;
    truncation: OutputTruncation;
    tunables: ShellTunables;
  },
): Promise<{ text: string; fullOutputPath?: string }> {
  const { persistIfTruncated = true, emptyText = "(no output)", logPath, truncation, tunables } = opts;
  const out = truncateOutput(acc, truncation, tunables.previewMaxBytes, emptyText);
  if (!out.truncated) return { text: out.body };
  let full: string | undefined;
  let text = out.body;
  if (persistIfTruncated) {
    full = logPath; // the monitor's log file already holds the complete output
    text += ` full: ${full}`;
  }
  return { text: text + "]", fullOutputPath: full };
}

export async function runShell(
  command: string,
  waitforSec: number,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined,
  onPartial: ((t: string) => void) | undefined,
  describe: string | undefined,
  maxWaitfor: number,
  truncation: OutputTruncation,
  tunables: ShellTunables,
): Promise<ShResult> {
  const pathId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessDir = env.PI_SESSION_DIR;
  const sessScope = env.PI_SESSION_ID;
  let handle: Awaited<ReturnType<typeof launchMonitor>>;
  try {
    handle = await launchMonitor(command, env, pathId);
  } catch (e) {
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: `sh-monitor launch failed: ${(e as Error).message}`,
    };
  }
  const { client, logPath } = handle;

  let status: Awaited<ReturnType<MonitorClient["stat"]>>;
  try {
    status = await client.stat();
  } catch (e) {
    client.close();
    return { id: null, status: "completed", exitCode: -1, text: `sh-monitor stat failed: ${(e as Error).message}` };
  }
  const pid = status.pid;
  const id = String(pid);

  const decoder = new StringDecoder("utf8");
  let exitCode: number | null = null;
  let lastUpd = 0;
  const entry: BackgroundChild = {
    id,
    pid,
    command,
    describe,
    client,
    logPath,
    sessDir,
    sessScope,
    acc: "",
    decoder,
    exitCode: null,
    done: false,
    bytesEmitted: 0,
    linesEmitted: 0,
    colBytes: 0,
  };

  let exitResolve!: () => void;
  const exitP = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const onEvent = (ev: { kind: "data"; off: number; buf: Buffer } | { kind: "exit"; exitCode: number; bytes: number }) => {
    if (ev.kind === "data") {
      entry.acc += entry.decoder.write(ev.buf);
      entry.bytesEmitted = ev.off + ev.buf.length;
      const lastNl = ev.buf.lastIndexOf(0x0a);
      if (lastNl === -1) entry.colBytes += ev.buf.length;
      else {
        entry.linesEmitted += ev.buf.subarray(0, lastNl).filter((b) => b === 0x0a).length + 1;
        entry.colBytes = ev.buf.length - 1 - lastNl;
      }
      if (Buffer.byteLength(entry.acc) > tunables.maxAcc) {
        while (Buffer.byteLength(entry.acc) > tunables.maxAcc)
          entry.acc = entry.acc.slice(Math.max(1, Math.ceil(entry.acc.length * 0.1)));
        const c0 = entry.acc.charCodeAt(0);
        if (c0 >= 0xdc00 && c0 <= 0xdfff) entry.acc = entry.acc.slice(1); // drop lone low surrogate
      }
      const now = Date.now();
      if (onPartial && now - lastUpd >= tunables.updateMs) {
        lastUpd = now;
        void buildOutputText(entry.acc, { persistIfTruncated: false, truncation, tunables }).then((r) =>
          onPartial(r.text),
        );
      }
    } else {
      if (entry.done) return;
      entry.acc += entry.decoder.end();
      exitCode = ev.exitCode;
      completeBackground(entry, ev.exitCode);
      exitResolve();
    }
  };
  try {
    await client.subscribe(onEvent);
  } catch (e) {
    if (!entry.done) {
      client.close();
      return { id: null, status: "completed", exitCode: -1, text: `sh-monitor subscribe failed: ${(e as Error).message}` };
    }
  }
  const onSockClose = () => {
    if (!stopBackground(entry)) return;
    exitCode = -1;
    exitResolve();
  };
  client.onClose(onSockClose);

  const onAbort = () => client.sendSignal("SIGKILL");
  signal?.addEventListener("abort", onAbort);

  let timer: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([
    exitP.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), Math.min(waitforSec, maxWaitfor) * 1000);
    }),
  ]);
  signal?.removeEventListener("abort", onAbort);
  clearTimeout(timer!);

  if (completed) {
    client.close();
    let content = "";
    try {
      content = (await readFile(logPath)).toString("utf8"); // monitor flushed before sending exit
    } catch {}
    const { text, fullOutputPath } = await buildOutputText(content, { logPath, truncation, tunables });
    if (!fullOutputPath) await rm(logPath, { force: true }).catch(() => {});
    return { id: null, status: "completed", exitCode, text, fullOutputPath };
  }
  // still running → background it; the subscribe callback stays live for completion
  bg.set(id, entry);
  if (sessDir && sessScope)
    void client.bindResume().then((sp) => {
      if (sp && bg.has(id)) void writeResumeRecord(sessDir, sessScope, id, sp, command, logPath, describe);
    });
  const { text } = await buildOutputText(entry.acc, { logPath, truncation, tunables });
  return {
    id,
    status: "running",
    exitCode: null,
    text,
    fullOutputPath: logPath,
    cursor: { line: entry.linesEmitted + 1, column: entry.colBytes, bytes: entry.bytesEmitted },
  };
}

/** Complete a tracked background shell: notify (or marker if owner away), then clean up. */
function completeBackground(entry: BackgroundChild, exitCode: number): void {
  if (entry.done) return;
  entry.done = true;
  entry.exitCode = exitCode;
  const { id, command, client, logPath, sessDir, sessScope } = entry;
  if (!bg.has(id)) return;
  if (!entry.signaled) {
    if (entry.sessScope === currentScope) {
      completionHook?.(id, command, exitCode, "completed", { path: logPath });
    } else if (sessDir && sessScope) {
      // owner away: persist the off-screen completion for the owner's resume to surface
      void writeCompletedRecord(sessDir, sessScope, id, {
        pid: id,
        command,
        exitCode,
        logPath,
        completedAt: Date.now(),
      });
    }
  }
  bg.delete(id);
  client.close(); // backgrounded entry finished → disconnect; monitor drains + exits
  if (sessDir && sessScope) void removeResumeRecord(sessDir, sessScope, id);
}

/** sh-monitor connection dropped without an exit event (supervisor crashed). False if already done/signaled. */
function stopBackground(entry: BackgroundChild): boolean {
  if (entry.done || entry.signaled) return false;
  entry.done = true;
  entry.exitCode = -1;
  entry.acc += entry.decoder.end();
  const { id, command, client, logPath, sessDir, sessScope } = entry;
  if (!bg.has(id)) return true;
  if (entry.sessScope === currentScope) completionHook?.(id, command, -1, "stopped", { path: logPath });
  bg.delete(id);
  client.close();
  // supervisor connection dropped → the resume socket is gone too; drop the stale record
  if (sessDir && sessScope) void removeResumeRecord(sessDir, sessScope, id);
  return true;
}

export function signalChild(id: string, sig: string): boolean {
  if (id.startsWith("rpt-")) return signalRepeat(id, sig);
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== currentScope) return false;
  e.client.sendSignal(sig);
  return true;
}

export const silenceChild = (id: string): boolean => {
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== currentScope) return false;
  e.signaled = true;
  return true;
};

/**
 * Release a background PID to run on its own: disconnect pi from the supervisor
 * without signalling the child. The child + sh-monitor keep running (detached),
 * output keeps draining to the log file, no completion notification fires, and
 * killAll/session-shutdown will not touch it. pi releases its own pipe/socket
 * handles (orphan) so its libuv event loop can idle and `pi --print` can exit;
 * the child + sh-monitor survive and keep draining to the log. Returns the detached
 * child's log path, or
 * `null` if the id is not active.
 */
export const detachChild = (id: string): string | null => {
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== currentScope) return null;
  e.signaled = true; // suppress any in-flight completion hook
  if (e.sessDir && e.sessScope) void removeResumeRecord(e.sessDir, e.sessScope, id);
  e.client.orphan();
  bg.delete(id);
  return e.logPath;
};

export const getBackgroundCount = (): number =>
  [...bg.values()].filter((e) => e.sessScope === currentScope).length;
export const hasActiveBackground = (): boolean =>
  [...bg.values()].some((e) => !e.done && e.sessScope === currentScope) || hasActiveRepeats();

export const getShellBackgrounds = () =>
  [...bg.values()].filter((e) => e.sessScope === currentScope).map((e) => ({ id: e.id, describe: e.describe }));

export const getActiveBackgrounds = () => [
  ...[...bg.values()].filter((e) => e.sessScope === currentScope).map((e) => ({ id: e.id, describe: e.describe })),
  ...getActiveRepeats(),
];

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.sessScope !== currentScope || e.done) continue;
    e.done = true;
    e.client.kill("SIGKILL"); // fire-and-forget signal + destroy socket
    bg.delete(e.id);
    if (e.sessDir && e.sessScope) void removeResumeRecord(e.sessDir, e.sessScope, e.id);
  }
  killAllRepeats();
}

/**
 * Re-establish a conversation's backgrounded shells after a pi restart/reload.
 * `scope` is the conversation session id; only that conversation's resume
 * records (`<sessionDir>/sh-mon/<scope>/`) are read, so concurrent agents in
 * the same cwd never cross-read each other's records. Each still-living record
 * is re-attached as a full background entry (listable, signalable, detachable),
 * reusing the same completion path as in-process shells — so an off-screen
 * completion still notifies the owner (or records a marker if they're away).
 * A record whose socket is gone is stale (shell completed or supervisor died):
 * remove it silently — cleanup, not a shell event.
 */
export async function resumeBackgroundShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<void> {
  if (!sessionDir || !scope) return;
  const records = await readResumeRecords(sessionDir, scope);
  for (const r of records) {
    const c = new ResumeClient(r.sockPath);
    try {
      await Promise.race([
        c.whenReady,
        new Promise<void>((_, rej) => setTimeout(() => rej(new Error("resume connect timeout")), 2000)),
      ]);
    } catch {
      c.close();
      void removeResumeRecord(sessionDir, scope, r.pid);
      continue;
    }
    const entry: BackgroundChild = {
      id: r.pid,
      pid: Number(r.pid),
      command: r.cmd,
      describe: r.describe,
      client: c,
      logPath: r.logPath ?? "",
      sessDir: sessionDir,
      sessScope: scope,
      acc: "",
      decoder: new StringDecoder("utf8"),
      exitCode: null,
      done: false,
      bytesEmitted: 0,
      linesEmitted: 0,
      colBytes: 0,
    };
    bg.set(r.pid, entry);
    c.subscribe((ev) => {
      if (ev.kind === "exit") completeBackground(entry, ev.exitCode);
    });
    c.onClose(() => stopBackground(entry));
  }
}
