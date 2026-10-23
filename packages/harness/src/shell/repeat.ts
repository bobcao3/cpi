import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { launchMonitor } from "./monitor.ts";
import { storage_directory } from "../lib/storage/paths.ts";
import { reserve_owned_operation } from "../lib/storage/operations.ts";
import {
  captureSessionOwner,
  type SessionOwner,
} from "../lib/storage/owner.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";
import type { RepeatMonitor } from "./background-types.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  recordRepeatStart,
  recordRepeatShutdown,
  recordRepeatTerminal,
  resumeRepeatMonitors,
} from "./repeat-persistence.ts";
import {
  beginActivity,
  updateActivity,
  finishActivity,
} from "../lib/activity.ts";
import {
  bind_repeat_storage,
  close_repeat_storage,
  join_repeat_native,
  join_repeat_shutdown,
  repeat_pending,
  signal_repeat_child,
  stop_repeat,
} from "./repeat-lifecycle.ts";
export { createRepeatTool } from "./repeat-tool.ts";
export { getRepeatHistory } from "./repeat-persistence.ts";

export interface RepeatLogRange {
  path: string;
  startLine?: number;
  endLine?: number;
}
export type RepeatCompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "stopped" | "breach",
  log?: RepeatLogRange,
) => void;
interface RepeatState {
  monitors: Map<string, RepeatMonitor>;
  hook?: RepeatCompletionHook;
  getScope: () => string | undefined;
}
const shared = globalThis as typeof globalThis & {
  __cpiRepeatState?: RepeatState;
};
const state: RepeatState = (shared.__cpiRepeatState ??= {
  monitors: new Map(),
  getScope: () => undefined,
});
const rpt = state.monitors;
export const setRepeatScopeGetter = (fn: () => string | undefined): void => {
  state.getScope = fn;
};
export const setRepeatCompletionHook = (fn: RepeatCompletionHook): void => {
  state.hook = fn;
};

function writeLog(mon: RepeatMonitor, chunk: string | Buffer): void {
  if (!chunk.length || mon.logStream.destroyed || mon.logStream.writableEnded)
    return;
  mon.logStream.write(chunk);
  for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    if (byte === 0x0a) mon.logLine++;
  mon.outputBytes = (mon.outputBytes ?? 0) + Buffer.byteLength(chunk);
  updateActivity(`monitor:${mon.logPath}`, {
    metrics: { output_bytes: mon.outputBytes, last_output_at: Date.now() },
  });
}

export async function resumeRepeats(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notify = true,
  owner?: SessionOwner,
): Promise<void> {
  owner ??= captureSessionOwner(
    ctx.sessionManager,
    join(getAgentDir(), "jobs"),
  );
  for (const mon of rpt.values()) {
    mon.settled ??= () => rpt.delete(mon.id);
    mon.notifyStopped ??= () => {
      if (mon.stopSignal)
        notifyRepeat(
          mon,
          mon.lastExit ?? null,
          mon.breached ? "breach" : "stopped",
        );
    };
  }
  await resumeRepeatMonitors(pi, ctx, rpt, notify, owner);
}

function notifyRepeat(
  mon: RepeatMonitor,
  code: number | null,
  outcome: "stopped" | "breach",
): void {
  if (
    mon.completionSent ||
    /^(?:SIG)?(?:KILL|0*9)$/i.test(mon.stopSignal ?? "") ||
    mon.sessScope !== state.getScope()
  )
    return;
  mon.completionSent = true;
  state.hook?.(mon.id, mon.command, code, outcome, {
    path: mon.logPath,
    startLine: mon.startLine,
    endLine: mon.logLine,
  });
}

async function runIteration(mon: RepeatMonitor): Promise<number | null> {
  mon.invocation++;
  mon.startLine = mon.logLine + 1;
  mon.nativeJoined = false;
  mon.client = undefined;
  mon.signalSent = false;
  mon.observingChild = true;
  const launchId = `repeat-${randomUUID()}`;
  writeLog(
    mon,
    `═══════════════════════════════════════════════════════════════════════════════\nInvocation ${mon.invocation} — ${new Date().toISOString()}\nCommand: ${mon.command}\n───────────────────────────────────────────────────────────────────────────────\n`,
  );
  mon.launching = launchMonitor(
    mon.command,
    mon.env,
    launchId,
    mon.shell,
    mon.cwd,
    false,
    mon.operation?.signal,
    (error, retry) => {
      mon.launchCleanup = retry;
      repeat_pending(mon, error);
    },
  );
  const { client } = await mon.launching;
  mon.client = client;
  if (mon.nativeJoined) return null;
  if (!mon.running && !mon.operation?.signal.aborted) signal_repeat_child(mon);
  mon.pid = (await client.stat()).pid;
  if (mon.nativeJoined) return null;
  updateActivity(`monitor:${mon.logPath}`, {
    metrics: {
      phase: "executing",
      pid: mon.pid,
      invocation: mon.invocation,
      next_due_at: 0,
    },
  });
  if (mon.running)
    mon.timeout = setTimeout(() => {
      mon.breached = true;
      updateActivity(`monitor:${mon.logPath}`, {
        status: "stopping",
        metrics: { breach: 1 },
      });
      void join_repeat_native(mon).catch((error) => repeat_pending(mon, error));
    }, mon.intervalSec * 1000);
  const exited = new Promise<number | null>((resolve) => {
    mon.wake = resolve;
  });
  client.onClose(() => mon.wake?.(null));
  await client.subscribe((event) => {
    if (!mon.observingChild) return;
    if (event.kind === "data") writeLog(mon, event.buf);
    else mon.wake?.(event.exitCode);
  });
  const code = await exited;
  mon.wake = undefined;
  clearTimeout(mon.timeout);
  if (code === null && !mon.nativeJoined)
    throw new Error(
      client.target?.error ??
        "Repeat connection lost before native writer joined",
    );
  await join_repeat_native(mon);
  return code;
}

async function runRepeat(mon: RepeatMonitor): Promise<void> {
  let code: number | null = null;
  let outcome: "stopped" | "breach" = "stopped";
  let failed = false;
  try {
    while (mon.running && !mon.breached) {
      code = await runIteration(mon);
      mon.lastExit = code;
      if (!mon.running) break;
      const next = !mon.breached && code === 0;
      outcome = mon.breached ? "breach" : "stopped";
      writeLog(
        mon,
        `───────────────────────────────────────────────────────────────────────────────\nExit: ${code ?? "unknown"} (${next ? "continue" : outcome})\n═══════════════════════════════════════════════════════════════════════════════\n`,
      );
      if (!next) break;
      updateActivity(`monitor:${mon.logPath}`, {
        metrics: {
          phase: "waiting",
          next_due_at: Date.now() + mon.intervalSec * 1000,
          last_exit: 0,
        },
      });
      await new Promise<void>((resolve) => {
        mon.wake = () => resolve();
        mon.nextTimer = setTimeout(resolve, mon.intervalSec * 1000);
      });
      mon.wake = undefined;
    }
  } catch (error) {
    failed = true;
    console.error(`Repeat ${mon.id} failed:`, error);
    mon.running = false;
    clearTimeout(mon.timeout);
    if (
      mon.stopSignal &&
      !mon.operation?.signal.aborted &&
      (mon.launchCleanup || (mon.client && !mon.nativeJoined))
    ) {
      repeat_pending(mon, error);
      return;
    }
    try {
      await join_repeat_native(mon);
    } catch (cleanupError) {
      repeat_pending(mon, cleanupError);
      return;
    }
  }
  const cancelled = !mon.running && !failed;
  mon.running = false;
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  recordRepeatTerminal(mon, outcome, code);
  await close_repeat_storage(mon);
  finishActivity(
    `monitor:${mon.logPath}`,
    cancelled && !failed && !mon.logError ? "cancelled" : "failed",
    {
      last_exit: code ?? "signal",
      breach: mon.breached ? 1 : 0,
      ...(mon.logError ? { log_error: 1 } : {}),
    },
  );
  if (!cancelled || mon.stopSignal) notifyRepeat(mon, code, outcome);
}

export function startRepeat(
  command: string,
  intervalSec: number,
  env: NodeJS.ProcessEnv,
  describe?: string,
  shell: ShellProfile = resolveShell("bash"),
  cwd: string = process.cwd(),
  env_file?: string,
  owner?: SessionOwner,
): string {
  if (rpt.size >= 256) throw new Error("Repeat monitor limit exceeded");
  if (!Number.isFinite(intervalSec) || intervalSec < 5 || intervalSec > 60)
    throw new Error("Invalid repeat interval");
  owner = owner ? Object.freeze({ ...owner }) : undefined;
  const operation = owner
    ? reserve_owned_operation(owner, undefined, "external")
    : undefined;
  const id = `rpt-${randomUUID()}`;
  let mon: RepeatMonitor;
  try {
    const logPath = join(
      storage_directory("state", "shell-repeat", { env }),
      `${id}-${Date.now()}.log`,
    );
    mon = {
      id,
      command,
      shell,
      owner,
      operation,
      sessScope: (owner ? env.PI_SESSION_ID : undefined) ?? state.getScope(),
      describe,
      intervalSec,
      env,
      cwd,
      running: true,
      breached: false,
      pid: -1,
      logPath,
      logStream: createWriteStream(logPath, { flags: "a", mode: 0o600 }),
      logLine: 0,
      invocation: 0,
      startLine: 1,
      settled: () => rpt.delete(id),
    };
  } catch (error) {
    operation?.finish();
    throw error;
  }
  mon.notifyStopped = () => {
    if (mon.stopSignal)
      notifyRepeat(
        mon,
        mon.lastExit ?? null,
        mon.breached ? "breach" : "stopped",
      );
  };
  bind_repeat_storage(mon);
  try {
    recordRepeatStart(mon, env_file);
    rpt.set(id, mon);
    beginActivity({
      id: `monitor:${mon.logPath}`,
      kind: "monitor",
      status: "running",
      session_id: mon.sessScope,
      label: describe || command,
      command,
      cwd,
      started_at: Date.now(),
      log_path: mon.logPath,
      metrics: { interval_seconds: intervalSec, invocation: 0 },
    });
  } catch (error) {
    mon.running = false;
    mon.task = close_repeat_storage(mon).catch((cleanupError) =>
      repeat_pending(mon, cleanupError),
    );
    throw error;
  }
  mon.task = runRepeat(mon).catch((error) => repeat_pending(mon, error));
  return id;
}

export function signalRepeat(id: string, signal: string): boolean {
  const mon = rpt.get(id);
  if (!mon || mon.sessScope !== state.getScope()) return false;
  try {
    recordRepeatTerminal(mon, "stopped");
  } finally {
    stop_repeat(mon, signal);
  }
  return true;
}
export const getRepeatCount = (): number =>
  [...rpt.values()].filter((m) => m.sessScope === state.getScope()).length;
export const hasActiveRepeats = (): boolean =>
  [...rpt.values()].some((m) => m.sessScope === state.getScope());
export const getActiveRepeats = () =>
  [...rpt.values()]
    .filter((m) => m.sessScope === state.getScope())
    .map((e) => ({
      id: e.id,
      describe: e.describe,
      uid: e.client?.target?.uid,
      socketPath: e.client?.target?.socketPath,
      isPty: false,
    }));

export async function joinRepeatsForShutdown(
  scope = state.getScope(),
): Promise<void> {
  const monitors = [...rpt.values()].filter((mon) => mon.sessScope === scope);
  const results = await Promise.allSettled(
    monitors.map(async (mon) => {
      try {
        recordRepeatShutdown(mon);
      } finally {
        await join_repeat_shutdown(mon);
      }
    }),
  );
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(
      errors,
      "Repeat shutdown could not confirm writer closure",
    );
}

export function killAllRepeats(): void {
  for (const mon of rpt.values()) {
    if (mon.sessScope !== state.getScope()) continue;
    recordRepeatShutdown(mon);
    stop_repeat(mon);
  }
}
