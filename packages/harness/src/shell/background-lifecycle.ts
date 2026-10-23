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
import type { SessionOwner } from "../lib/storage/owner.ts";
import { adoptShellStorage, holdShellRecovery } from "./storage.ts";

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
    void entry.storage?.reap().catch(() => {});
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
    void entry.storage?.reap().catch(() => {});
    client.close();
  }
}

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.sessScope !== shellState.scope || e.done) continue;
    void (e.storage?.reap() ?? e.client.reap()).catch(() => {});
    recordShellEnd(e, "shutdown");
    e.cancelRequested = true;
    updateActivity(e.activityId, { status: "stopping" });
    e.done = true;
    e.client.close();
    bg.delete(e.id);
  }
  killAllRepeats();
}

export async function resumeBackgroundShells(
  sessionDir: string | undefined,
  scope: string | undefined,
  owner?: SessionOwner,
): Promise<void> {
  if (!sessionDir || !scope) return;
  const records = shellRecords(scope).filter((r) => r.status === "running");
  const unavailable = new Set<string>();
  const recoveries = new Map<
    string,
    {
      owner: SessionOwner;
      hold: ReturnType<typeof holdShellRecovery>;
    }
  >();
  for (const record of records) {
    const existing = bg.get(record.pid);
    const captured =
      (existing?.activityId === record.id
        ? existing.storage?.operation.owner
        : undefined) ??
      record.artifact_owner ??
      (existing?.activityId === record.id
        ? existing.artifact_owner
        : undefined) ??
      owner;
    if (!captured) continue;
    const original = Object.freeze({ ...captured });
    try {
      recoveries.set(record.id, {
        owner: original,
        hold: holdShellRecovery(record, original),
      });
    } catch (error) {
      unavailable.add(record.id);
      console.error("cpi shell recovery pending:", record.id, error);
    }
    if (existing?.activityId === record.id) existing.artifact_owner = original;
  }
  for (const r of records) {
    if (unavailable.has(r.id)) continue;
    const existing = bg.get(r.pid);
    const recovery = recoveries.get(r.id);
    if (existing?.activityId === r.id) {
      if (existing.storage) {
        recovery?.hold.finish();
        continue;
      }
      if (!recovery) continue;
      try {
        existing.storage = await adoptShellStorage(
          existing.client,
          r,
          recovery.owner,
          existing,
        );
        updateShellRecord(r.id, {
          artifact_owner: existing.storage.operation.owner,
        });
        if (existing.done) await existing.storage.reap();
        recovery.hold.finish();
      } catch (error) {
        recovery.hold.pending(error);
        console.error("cpi shell recovery pending:", r.id, error);
      }
      continue;
    }
    let target: Awaited<ReturnType<typeof shellTarget>> | undefined;
    try {
      target = await shellTarget(r);
    } catch (error) {
      if (recovery) {
        recovery.hold.pending(error);
        console.error("cpi shell recovery pending:", r.id, error);
        continue;
      }
      if (
        !(error instanceof ShellIdentityError) &&
        (error as NodeJS.ErrnoException).code !== "ENOENT"
      )
        continue;
    }
    if (!target || (existing && !existing.done)) {
      if (recovery) {
        const error = new ShellIdentityError(
          "Shell recovery resource conflict",
        );
        recovery.hold.pending(error);
        console.error("cpi shell recovery pending:", r.id, error);
        continue;
      }
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
      if (recovery) {
        recovery.hold.pending(error);
        console.error("cpi shell recovery pending:", r.id, error);
        continue;
      }
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
    if (recovery) {
      try {
        entry.storage = await adoptShellStorage(c, r, recovery.owner, entry);
        updateShellRecord(r.id, {
          artifact_owner: entry.storage.operation.owner,
        });
      } catch (error) {
        recovery.hold.pending(error);
        console.error("cpi shell recovery pending:", r.id, error);
        c.close();
        if (entry.storage)
          void entry.storage
            .reap()
            .catch((cleanupError) =>
              console.error(
                "cpi shell recovery cleanup pending:",
                r.id,
                cleanupError,
              ),
            );
        continue;
      }
    }
    bg.set(r.pid, entry);
    observeShell(entry, r.cwd, true);
    updateActivity(entry.activityId, {
      metrics: { output_bytes: entry.bytesEmitted },
    });
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
      c.onClose(() => stopBackground(entry));
      recovery?.hold.finish();
    } catch (error) {
      c.close();
      if (bg.get(r.pid) === entry) bg.delete(r.pid);
      recovery?.hold.pending(error);
      console.error("cpi shell recovery pending:", r.id, error);
      if (entry.storage) {
        void entry.storage
          .reap()
          .catch((cleanupError) =>
            console.error(
              "cpi shell recovery cleanup pending:",
              r.id,
              cleanupError,
            ),
          );
      }
    }
  }
}
