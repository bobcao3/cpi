/**
 * Spawns each command through a detached `sh-monitor` supervisor so the
 * child's output pipe is owned by the supervisor, never by pi: detach
 * survives pi's exit (no SIGPIPE), and the log file is the durable source
 * of truth — acc is only live preview.
 */

import { rm, readFile } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import {
  buildOutputText,
  accumulateOutput,
  type ShellTunables,
  type ShResult,
  type OutputTruncation,
} from "./output.ts";
export { buildOutputText } from "./output.ts";
export type {
  ShellTunables,
  ShResult,
  OutputCursor,
  OutputTruncation,
} from "./output.ts";
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
import { resolveShell, type ShellProfile } from "./profile.ts";
import {
  updateActivity,
  finishActivity,
  setActivitySession,
} from "../lib/activity.ts";
import { observeShell, finishShell } from "./activity.ts";
import type { BackgroundChild, CompletionHook } from "./background-types.ts";
export type { CompletionHook } from "./background-types.ts";

const bg = new Map<string, BackgroundChild>();
let completionHook: CompletionHook | undefined;

let currentScope: string | undefined;
export const setCurrentScope = (scope: string | undefined): void => {
  currentScope = scope;
  setActivitySession(scope);
};
setRepeatScopeGetter(() => currentScope);

export const setCompletionHook = (fn: CompletionHook) => {
  completionHook = fn;
  setRepeatCompletionHook(fn);
};

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
  shell: ShellProfile = resolveShell("bash"),
  cwd: string = process.cwd(),
): Promise<ShResult> {
  if (signal?.aborted)
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: "Aborted before start.",
    };
  const pathId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessDir = env.PI_SESSION_DIR;
  const sessScope = env.PI_SESSION_ID;
  let handle: Awaited<ReturnType<typeof launchMonitor>>;
  try {
    handle = await launchMonitor(command, env, pathId, shell, cwd);
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
    return {
      id: null,
      status: "completed",
      exitCode: -1,
      text: `sh-monitor stat failed: ${(e as Error).message}`,
    };
  }
  const pid = status.pid;
  const id = String(pid);

  const decoder = new StringDecoder("utf8");
  let exitCode: number | null = null;
  let lastUpd = 0;
  const entry: BackgroundChild = {
    id,
    activityId: `shell:${logPath}`,
    startedAt: Date.now(),
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
  const onEvent = (
    ev:
      | { kind: "data"; off: number; buf: Buffer }
      | { kind: "exit"; exitCode: number; bytes: number },
  ) => {
    if (ev.kind === "data") {
      accumulateOutput(entry, ev.buf, ev.off, tunables.maxAcc);
      updateActivity(entry.activityId, {
        metrics: {
          output_bytes: entry.bytesEmitted,
          last_output_at: Date.now(),
        },
      });
      const now = Date.now();
      if (onPartial && now - lastUpd >= tunables.updateMs) {
        lastUpd = now;
        void buildOutputText(entry.acc, {
          persistIfTruncated: false,
          truncation,
          tunables,
        }).then((r) => onPartial(r.text));
      }
    } else {
      finishShell(entry, ev.exitCode, ev.bytes);
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
      return {
        id: null,
        status: "completed",
        exitCode: -1,
        text: `sh-monitor subscribe failed: ${(e as Error).message}`,
      };
    }
  }
  const onSockClose = () => {
    if (!stopBackground(entry)) return;
    exitCode = -1;
    exitResolve();
  };
  client.onClose(onSockClose);

  const onAbort = () => client.sendSignal("SIGKILL");
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  let timer: ReturnType<typeof setTimeout>;
  const completed = await Promise.race([
    exitP.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(
        () => r(false),
        Math.min(waitforSec, maxWaitfor) * 1000,
      );
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
    const { text, fullOutputPath } = await buildOutputText(content, {
      logPath,
      truncation,
      tunables,
    });
    if (!fullOutputPath) await rm(logPath, { force: true }).catch(() => {});
    return { id: null, status: "completed", exitCode, text, fullOutputPath };
  }
  // still running → background it; the subscribe callback stays live for completion
  bg.set(id, entry);
  observeShell(entry, cwd);
  if (sessDir && sessScope)
    void client
      .bindResume()
      .then((sp) => {
        if (sp && bg.has(id))
          void writeResumeRecord(
            sessDir,
            sessScope,
            id,
            sp,
            command,
            logPath,
            describe,
          );
      })
      .catch(() => {});
  const { text } = await buildOutputText(entry.acc, {
    logPath,
    truncation,
    tunables,
  });
  return {
    id,
    status: "running",
    exitCode: null,
    text,
    fullOutputPath: logPath,
    cursor: {
      line: entry.linesEmitted + 1,
      column: entry.colBytes,
      bytes: entry.bytesEmitted,
    },
  };
}

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
  finishActivity(
    entry.activityId,
    entry.cancelRequested ? "cancelled" : "failed",
    { connection_lost: 1 },
  );
  if (entry.done || entry.signaled) return false;
  entry.done = true;
  entry.exitCode = -1;
  entry.acc += entry.decoder.end();
  const { id, command, client, logPath, sessDir, sessScope } = entry;
  if (!bg.has(id)) return true;
  if (entry.sessScope === currentScope)
    completionHook?.(id, command, -1, "stopped", { path: logPath });
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
  if (
    process.platform === "win32" ||
    ["SIGINT", "SIGTERM", "SIGKILL", "2", "15", "9"].includes(sig)
  ) {
    e.cancelRequested = true;
    updateActivity(e.activityId, { status: "stopping" });
  }
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
 * Release a background PID to run on its own: disconnect without signalling,
 * no completion notification, killAll/session-shutdown won't touch it. Orphan
 * pi's pipe handles so its libuv loop can idle and `pi --print` can exit.
 * Returns the log path, or null if the id is not active.
 */
export const detachChild = (id: string): string | null => {
  const e = bg.get(id);
  if (!e || e.done || e.sessScope !== currentScope) return null;
  e.signaled = true; // suppress any in-flight completion hook
  finishActivity(e.activityId, "detached");
  if (e.sessDir && e.sessScope)
    void removeResumeRecord(e.sessDir, e.sessScope, id);
  e.client.orphan();
  bg.delete(id);
  return e.logPath;
};

export const getBackgroundCount = (): number =>
  [...bg.values()].filter((e) => e.sessScope === currentScope).length;
export const hasActiveBackground = (): boolean =>
  [...bg.values()].some((e) => !e.done && e.sessScope === currentScope) ||
  hasActiveRepeats();

export const getShellBackgrounds = () =>
  [...bg.values()]
    .filter((e) => e.sessScope === currentScope)
    .map((e) => ({ id: e.id, describe: e.describe }));

export const getActiveBackgrounds = () => [
  ...[...bg.values()]
    .filter((e) => e.sessScope === currentScope)
    .map((e) => ({ id: e.id, describe: e.describe })),
  ...getActiveRepeats(),
];

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.sessScope !== currentScope || e.done) continue;
    e.cancelRequested = true;
    updateActivity(e.activityId, { status: "stopping" });
    e.done = true;
    e.client.kill("SIGKILL");
    bg.delete(e.id);
    if (e.sessDir && e.sessScope)
      void removeResumeRecord(e.sessDir, e.sessScope, e.id);
  }
  killAllRepeats();
}

/**
 * Re-attach a conversation's backgrounded shells after a pi restart/reload.
 * Records are scoped by conversation id, so concurrent agents in the same
 * cwd never cross-read each other's. A record whose socket is gone is stale
 * (shell completed or supervisor died): remove it silently.
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
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("resume connect timeout")), 2000),
        ),
      ]);
    } catch {
      c.close();
      void removeResumeRecord(sessionDir, scope, r.pid);
      continue;
    }
    const entry: BackgroundChild = {
      id: r.pid,
      activityId: `shell:${r.logPath ?? r.sockPath}`,
      startedAt: Date.now(),
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
    observeShell(entry, undefined, true);
    c.subscribe((ev) => {
      if (ev.kind === "exit") {
        finishShell(entry, ev.exitCode, ev.bytes);
        completeBackground(entry, ev.exitCode);
      }
    });
    c.onClose(() => stopBackground(entry));
  }
}
