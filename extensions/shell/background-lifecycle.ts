import { StringDecoder } from "node:string_decoder";
import { finishActivity, updateActivity } from "../lib/activity.ts";
import { finishShell, observeShell } from "./activity.ts";
import type { BackgroundChild, CompletionHook } from "./background-types.ts";
import {
  ResumeClient,
  readResumeRecords,
  removeResumeRecord,
  writeCompletedRecord,
} from "./monitor.ts";
import { killAllRepeats } from "./repeat.ts";
import { record_shell_shutdown } from "./shutdown.ts";

interface ShellState {
  backgrounds: Map<string, BackgroundChild>;
  scope?: string;
  completionHook?: CompletionHook;
}
const shared = globalThis as typeof globalThis & {
  __cpiShellState?: ShellState;
};
export const shellState: ShellState = (shared.__cpiShellState ??= {
  backgrounds: new Map(),
});
const bg = shellState.backgrounds;

export function completeBackground(
  entry: BackgroundChild,
  exitCode: number,
): void {
  if (entry.done) return;
  entry.done = true;
  entry.exitCode = exitCode;
  const { id, command, client, logPath, sessDir, sessScope } = entry;
  if (!bg.has(id)) return;
  if (!entry.signaled) {
    if (entry.sessScope === shellState.scope) {
      shellState.completionHook?.(id, command, exitCode, "completed", {
        path: logPath,
      });
    } else if (sessDir && sessScope) {
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
  client.close();
  if (sessDir && sessScope) void removeResumeRecord(sessDir, sessScope, id);
}

export function stopBackground(entry: BackgroundChild): boolean {
  finishActivity(
    entry.activityId,
    entry.cancelRequested ? "cancelled" : "failed",
    { connection_lost: 1 },
  );
  if (entry.done) return false;
  entry.done = true;
  entry.exitCode = -1;
  entry.acc += entry.decoder.end();
  const { id, command, client, logPath, sessDir, sessScope } = entry;
  if (!bg.has(id)) return true;
  if (!entry.signaled && entry.sessScope === shellState.scope)
    shellState.completionHook?.(id, command, -1, "stopped", { path: logPath });
  bg.delete(id);
  client.close();
  if (sessDir && sessScope) void removeResumeRecord(sessDir, sessScope, id);
  return true;
}

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.sessScope !== shellState.scope || e.done) continue;
    record_shell_shutdown(e.sessDir, e.sessScope, {
      id: e.id,
      command: e.command,
      describe: e.describe,
      log_path: e.logPath,
      kind: "shell",
    });
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

export async function resumeBackgroundShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<void> {
  if (!sessionDir || !scope) return;
  const records = await readResumeRecords(sessionDir, scope);
  for (const r of records) {
    if (bg.has(r.pid)) continue;
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
    c.onClose(() => stopBackground(entry));
    try {
      await c.subscribe((ev) => {
        if (ev.kind === "exit") {
          finishShell(entry, ev.exitCode, ev.bytes);
          completeBackground(entry, ev.exitCode);
        }
      });
    } catch {
      stopBackground(entry);
    }
  }
}
