import { randomUUID } from "node:crypto";
import { launchMonitor } from "./monitor.ts";
import { record_shell_shutdown } from "./shutdown.ts";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShell, type ShellProfile } from "./profile.ts";
import type { RepeatMonitor } from "./background-types.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  recordRepeatStart,
  recordRepeatTerminal,
  resumeRepeatMonitors,
} from "./repeat-persistence.ts";
export { createRepeatTool } from "./repeat-tool.ts";
export { getRepeatHistory } from "./repeat-persistence.ts";
import {
  beginActivity,
  updateActivity,
  finishActivity,
} from "../lib/activity.ts";

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

function writeLog(mon: RepeatMonitor, text: string): void {
  if (!text.length) return;
  mon.logStream.write(text);
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") mon.logLine++;
  mon.outputBytes = (mon.outputBytes ?? 0) + Buffer.byteLength(text);
  updateActivity(`monitor:${mon.logPath}`, {
    metrics: { output_bytes: mon.outputBytes, last_output_at: Date.now() },
  });
}

function writeLogBuffer(mon: RepeatMonitor, chunk: Buffer): void {
  if (!chunk.length) return;
  mon.logStream.write(chunk);
  for (const b of chunk) if (b === 0x0a) mon.logLine++;
  mon.outputBytes = (mon.outputBytes ?? 0) + chunk.length;
  updateActivity(`monitor:${mon.logPath}`, {
    metrics: { output_bytes: mon.outputBytes, last_output_at: Date.now() },
  });
}

export async function resumeRepeats(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  notify = true,
): Promise<void> {
  await resumeRepeatMonitors(pi, ctx, rpt, notify);
}

function stopRepeat(mon: RepeatMonitor): void {
  if (!mon.running) return;
  mon.running = false;
  if (mon.observingChild) {
    updateActivity(`monitor:${mon.logPath}`, { status: "stopping" });
  } else {
    finishActivity(`monitor:${mon.logPath}`, "cancelled");
  }
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  if (mon.client && mon.pid > 0) {
    try {
      mon.client!.sendSignal("SIGTERM");
    } catch {}
  }
  mon.logStream.end();
}

function finalize(
  mon: RepeatMonitor,
  code: number | null,
  outcome: "stopped" | "breach" | "next",
): void {
  const reason = outcome === "next" ? "continue" : outcome;
  const footer = `───────────────────────────────────────────────────────────────────────────────\nExit: ${code ?? "unknown"} (${reason})\n═══════════════════════════════════════════════════════════════════════════════\n`;
  writeLog(mon, footer);
  if (outcome === "next") {
    scheduleNext(mon);
    return;
  }
  recordRepeatTerminal(mon, outcome, code);
  mon.running = false;
  clearTimeout(mon.timeout);
  mon.logStream.end();
  finishActivity(`monitor:${mon.logPath}`, "failed", {
    last_exit: code ?? "signal",
    breach: outcome === "breach" ? 1 : 0,
  });
  if (mon.sessScope === state.getScope()) {
    state.hook?.(mon.id, mon.command, code, outcome, {
      path: mon.logPath,
      startLine: mon.startLine,
      endLine: mon.logLine,
    });
  }
  rpt.delete(mon.id);
}

function scheduleNext(mon: RepeatMonitor): void {
  if (!mon.running) return;
  updateActivity(`monitor:${mon.logPath}`, {
    metrics: {
      phase: "waiting",
      next_due_at: Date.now() + mon.intervalSec * 1000,
      last_exit: 0,
    },
  });
  mon.nextTimer = setTimeout(() => runIteration(mon), mon.intervalSec * 1000);
}

function runIteration(mon: RepeatMonitor): void {
  if (!mon.running || mon.breached) return;
  clearTimeout(mon.nextTimer);
  mon.invocation++;
  mon.startLine = mon.logLine + 1;
  const header = `═══════════════════════════════════════════════════════════════════════════════\nInvocation ${mon.invocation} — ${new Date().toISOString()}\nCommand: ${mon.command}\n───────────────────────────────────────────────────────────────────────────────\n`;
  writeLog(mon, header);

  mon.observingChild = true;
  void launchMonitor(
    mon.command,
    mon.env,
    `repeat-${randomUUID()}`,
    mon.shell,
    mon.cwd,
  )
    .then(async ({ client }) => {
      mon.client = client;
      mon.pid = (await client.stat()).pid;
      if (!mon.running) client.sendSignal(mon.stopSignal ?? "SIGTERM");
      mon.observingChild = true;
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
          client.sendSignal("SIGTERM");
        }, mon.intervalSec * 1000);
      await client.subscribe((event) => {
        if (event.kind === "data") {
          if (mon.running) writeLogBuffer(mon, event.buf);
          return;
        }
        mon.observingChild = false;
        client.close();
        clearTimeout(mon.timeout);
        if (!mon.running) {
          finishActivity(`monitor:${mon.logPath}`, "cancelled");
          return;
        }
        finalize(
          mon,
          event.exitCode,
          mon.breached ? "breach" : event.exitCode === 0 ? "next" : "stopped",
        );
      });
      client.onClose(() => {
        clearTimeout(mon.timeout);
        if (mon.running) finalize(mon, null, "stopped");
      });
    })
    .catch(() => {
      finishActivity(`monitor:${mon.logPath}`, "failed", { spawn_error: 1 });
      if (mon.running) finalize(mon, null, "stopped");
      else finishActivity(`monitor:${mon.logPath}`, "cancelled");
    });
}

export function startRepeat(
  command: string,
  intervalSec: number,
  env: NodeJS.ProcessEnv,
  describe?: string,
  shell: ShellProfile = resolveShell("bash"),
  cwd: string = process.cwd(),
  env_file?: string,
): string {
  if (rpt.size >= 256) throw new Error("Repeat monitor limit exceeded");
  if (!Number.isFinite(intervalSec) || intervalSec < 5 || intervalSec > 60)
    throw new Error("Invalid repeat interval");
  const id = `rpt-${randomUUID()}`;
  const logPath = join(tmpdir(), `pi-rpt-output-${id}-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const mon: RepeatMonitor = {
    id,
    command,
    shell,
    sessScope: state.getScope(),
    describe,
    intervalSec,
    env,
    cwd,
    running: true,
    breached: false,
    pid: -1,
    logPath,
    logStream,
    logLine: 0,
    invocation: 0,
    startLine: 1,
  };
  try {
    recordRepeatStart(mon, env_file);
  } catch (error) {
    logStream.end();
    throw error;
  }
  rpt.set(id, mon);
  beginActivity({
    id: `monitor:${logPath}`,
    kind: "monitor",
    status: "running",
    session_id: mon.sessScope,
    label: describe || command,
    command,
    cwd,
    started_at: Date.now(),
    log_path: logPath,
    metrics: { interval_seconds: intervalSec, invocation: 0 },
  });
  runIteration(mon);
  return id;
}

export function signalRepeat(id: string, signal: string): boolean {
  const mon = rpt.get(id);
  if (!mon || mon.sessScope !== state.getScope()) return false;
  recordRepeatTerminal(mon, "stopped");
  mon.stopSignal = signal;
  stopRepeat(mon);
  if (mon.client && mon.pid > 0) {
    try {
      mon.client.sendSignal(signal);
    } catch {}
  }
  rpt.delete(mon.id);
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

export function killAllRepeats(): void {
  for (const mon of rpt.values()) {
    if (mon.sessScope !== state.getScope()) continue;
    if (!recordRepeatTerminal(mon, "shutdown"))
      record_shell_shutdown(mon.env.PI_SESSION_DIR, mon.sessScope, {
        id: mon.id,
        command: mon.command,
        describe: mon.describe,
        log_path: mon.logPath,
        kind: "repeat",
      });
    stopRepeat(mon);
    rpt.delete(mon.id);
  }
}
