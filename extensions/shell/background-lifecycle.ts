import { StringDecoder } from "node:string_decoder";
import { finishActivity, updateActivity } from "../lib/activity.ts";
import { finishShell, observeShell } from "./activity.ts";
import type { BackgroundChild, CompletionHook } from "./background-types.ts";
import { ResumeClient } from "./monitor.ts";
import {
  recordShellEnd,
  ShellIdentityError,
  shellRecords,
  shellTarget,
  updateShellRecord,
} from "./persistence.ts";
import { killAllRepeats } from "./repeat.ts";

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
  const registered = bg.get(entry.id) === entry;
  entry.done = true;
  entry.exitCode = exitCode;
  const { id, command, client, logPath } = entry;
  try {
    recordShellEnd(
      entry,
      entry.cancelRequested
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed",
      exitCode,
      Boolean(entry.signaled || !registered),
    );
    if (!registered) return;
    if (!entry.signaled) {
      if (entry.sessScope === shellState.scope) {
        shellState.completionHook?.(id, command, exitCode, "completed", {
          path: logPath,
          activityId: entry.activityId,
          scope: entry.sessScope,
        });
      }
    }
  } finally {
    if (bg.get(entry.id) === entry) bg.delete(entry.id);
    client.close();
  }
}

export function stopBackground(entry: BackgroundChild): boolean {
  finishActivity(
    entry.activityId,
    entry.cancelRequested ? "cancelled" : "failed",
    { connection_lost: 1 },
  );
  if (entry.done) return false;
  const registered = bg.get(entry.id) === entry;
  entry.done = true;
  entry.exitCode = -1;
  const { id, command, client, logPath } = entry;
  try {
    recordShellEnd(entry, "lost", -1, Boolean(entry.signaled || !registered));
    entry.acc += entry.decoder.end();
    if (!registered) return true;
    if (!entry.signaled && entry.sessScope === shellState.scope)
      shellState.completionHook?.(id, command, -1, "stopped", {
        path: logPath,
        activityId: entry.activityId,
        scope: entry.sessScope,
      });
    return true;
  } finally {
    if (bg.get(entry.id) === entry) bg.delete(entry.id);
    client.close();
  }
}

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.sessScope !== shellState.scope || e.done) continue;
    recordShellEnd(e, "shutdown");
    e.cancelRequested = true;
    updateActivity(e.activityId, { status: "stopping" });
    e.done = true;
    e.client.kill("SIGKILL");
    bg.delete(e.id);
  }
  killAllRepeats();
}

export async function resumeBackgroundShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<void> {
  if (!sessionDir || !scope) return;
  const records = shellRecords(scope).filter((r) => r.status === "running");
  for (const r of records) {
    const existing = bg.get(r.pid);
    if (existing?.activityId === r.id) continue;
    let target: Awaited<ReturnType<typeof shellTarget>> | undefined;
    try {
      target = await shellTarget(r);
    } catch (error) {
      if (
        !(error instanceof ShellIdentityError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        continue;
    }
    if (!target || (existing && !existing.done)) {
      updateShellRecord(r.id, {
        status: "lost",
        acknowledgedAt: Date.now(),
        exitCode: -1,
      });
      finishActivity(r.id, "failed", { connection_lost: 1 });
      continue;
    }
    const c = new ResumeClient(r.statePath);
    try {
      await Promise.race([
        c.whenReady,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("resume connect timeout")), 2000),
        ),
      ]);
    } catch (error) {
      c.close();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        updateShellRecord(r.id, {
          status: "lost",
          acknowledgedAt: Date.now(),
          exitCode: -1,
        });
        finishActivity(r.id, "failed", { connection_lost: 1 });
      }
      continue;
    }
    const entry: BackgroundChild = {
      id: r.pid,
      activityId: r.id,
      startedAt: r.startedAt,
      pid: Number(r.pid),
      command: r.command,
      dialect: r.dialect,
      describe: r.describe,
      client: c,
      logPath: r.logPath,
      sessDir: sessionDir,
      sessScope: scope,
      acc: "",
      decoder: new StringDecoder("utf8"),
      exitCode: null,
      done: false,
      cancelRequested: r.cancelRequested,
      signaled: r.noticeSuppressed,
      bytesEmitted: target.bytes,
      linesEmitted: 0,
      colBytes: 0,
    };
    bg.set(r.pid, entry);
    observeShell(entry, r.cwd, true);
    updateActivity(entry.activityId, {
      metrics: { output_bytes: entry.bytesEmitted },
    });
    c.onClose(() => stopBackground(entry));
    try {
      await c.subscribe((ev) => {
        if (ev.kind === "data") {
          entry.bytesEmitted = Math.max(
            entry.bytesEmitted,
            ev.off + ev.buf.length,
          );
          updateActivity(entry.activityId, {
            metrics: {
              output_bytes: entry.bytesEmitted,
              last_output_at: Date.now(),
            },
          });
        } else {
          entry.bytesEmitted = ev.bytes;
          finishShell(entry, ev.exitCode, ev.bytes);
          completeBackground(entry, ev.exitCode);
        }
      });
    } catch {
      c.close();
      if (bg.get(r.pid) === entry) bg.delete(r.pid);
    }
  }
}
