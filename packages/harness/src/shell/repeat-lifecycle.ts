import type { RepeatMonitor } from "./background-types.ts";
import { readFile, stat } from "node:fs/promises";
import type { NativeResponse } from "./ghostmux-transport.ts";
import { finishActivity, updateActivity } from "../lib/activity.ts";
import { recordRepeatTerminal } from "./repeat-persistence.ts";
import type { SessionOwner } from "../lib/storage/owner.ts";
import { reserve_owned_operation } from "../lib/storage/operations.ts";

export function adopt_repeat_storage(
  mon: RepeatMonitor,
  owner: SessionOwner,
): void {
  if (mon.operation) return;
  mon.owner = Object.freeze({ ...owner });
  mon.operation = reserve_owned_operation(mon.owner);
  mon.legacy = !mon.task;
  bind_repeat_storage(mon);
}

function watch_legacy_stop(mon: RepeatMonitor): void {
  if (!mon.legacy || mon.task || !mon.operation) return;
  mon.task = (async () => {
    while (mon.operation && !mon.operation.signal.aborted) {
      if (!mon.observingChild) {
        const status = await mon.client?.stat();
        if (!status || status.exitCode !== null) {
          mon.lastExit = status?.exitCode ?? null;
          break;
        }
      }
      if (mon.client?.target?.error) throw new Error(mon.client.target.error);
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (!mon.operation || mon.operation.signal.aborted) return;
    await join_repeat_native(mon);
    await close_repeat_storage(mon);
    finishActivity(
      `monitor:${mon.logPath}`,
      mon.logError ? "failed" : "cancelled",
    );
  })().catch((error) => repeat_pending(mon, error));
}

export function repeat_pending(mon: RepeatMonitor, error: unknown): void {
  console.error(`Repeat ${mon.id} cleanup pending:`, error);
  updateActivity(`monitor:${mon.logPath}`, {
    status: "stopping",
    metrics: { cleanup_error: String(error) },
  });
  mon.operation?.pending(
    error,
    async () => {
      await join_repeat_native(mon);
      await mon.task;
      await close_repeat_storage(mon);
      finishActivity(`monitor:${mon.logPath}`, "failed", {
        cleanup_error: String(error),
      });
    },
    mon.logPath,
  );
}

export function signal_repeat_child(mon: RepeatMonitor): void {
  if (!mon.client || mon.nativeJoined || mon.signalSent) return;
  if (
    mon.legacy &&
    (mon.client.target?.completed || mon.client.target?.pid !== mon.pid)
  )
    return;
  mon.signalSent = true;
  const client = mon.client;
  const target = client.target;
  mon.signalTask = client
    .signal(mon.stopSignal ?? "SIGTERM")
    .catch(async (error) => {
      if (mon.nativeJoined) return;
      try {
        const native =
          target && (await stat(target.statusPath)).size <= 65536
            ? (JSON.parse(
                await readFile(target.statusPath, "utf8"),
              ) as NativeResponse)
            : undefined;
        if (
          target &&
          target.pid > 0 &&
          target.serverPid > 0 &&
          native?.session?.uid === target.uid &&
          native.session.pid === target.pid &&
          native.server_pid === target.serverPid &&
          Number.isInteger(native.session.exit_code)
        ) {
          mon.wake?.(native.session.exit_code);
          await join_repeat_native(mon);
          return;
        }
      } catch {}
      if (!mon.nativeJoined) repeat_pending(mon, error);
    });
}

export function stop_repeat(mon: RepeatMonitor, signal?: string): void {
  mon.running = false;
  if (signal !== undefined && mon.stopSignal === undefined)
    mon.stopSignal = signal;
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  updateActivity(`monitor:${mon.logPath}`, { status: "stopping" });
  if (!mon.observingChild) mon.wake?.(null);
  signal_repeat_child(mon);
  watch_legacy_stop(mon);
}

export async function join_repeat_native(mon: RepeatMonitor): Promise<void> {
  if (mon.reaping) return mon.reaping;
  mon.reaping = (async () => {
    await mon.launching?.catch(() => {});
    if (
      mon.legacy &&
      mon.observingChild &&
      (!mon.client ||
        mon.client.target?.completed ||
        mon.client.target?.pid !== mon.pid)
    )
      throw new Error(
        "Legacy repeat launch is still in flight; native producer is unconfirmed",
      );
    await mon.launchCleanup?.();
    if (mon.client && !mon.nativeJoined) await mon.client.reap();
    mon.launchCleanup = undefined;
    mon.nativeJoined = true;
    mon.observingChild = false;
    mon.client?.close();
    mon.wake?.(null);
  })();
  try {
    await mon.reaping;
  } finally {
    mon.reaping = undefined;
  }
}

export async function close_repeat_storage(mon: RepeatMonitor): Promise<void> {
  if (mon.launchCleanup || (mon.client && !mon.nativeJoined))
    throw new Error("Repeat native writer has not been joined");
  if (!mon.logStream.destroyed && !mon.logStream.writableEnded)
    mon.logStream.end();
  if (!mon.logClosed) throw new Error("Repeat log closure is not observable");
  await mon.logClosed;
  recordRepeatTerminal(mon, mon.breached ? "breach" : "stopped");
  if (mon.abort) mon.operation?.signal.removeEventListener("abort", mon.abort);
  mon.operation?.finish();
  mon.operation = undefined;
  mon.settled?.();
  mon.notifyStopped?.();
}

export async function join_repeat_shutdown(mon: RepeatMonitor): Promise<void> {
  mon.running = false;
  mon.signalSent = true;
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  if (!mon.observingChild) mon.wake?.(null);
  try {
    await join_repeat_native(mon);
    await mon.task;
    await close_repeat_storage(mon);
    finishActivity(
      `monitor:${mon.logPath}`,
      mon.logError ? "failed" : "cancelled",
    );
  } catch (error) {
    repeat_pending(mon, error);
    throw error;
  }
}

export function bind_repeat_storage(mon: RepeatMonitor): void {
  if (!mon.storageBound) {
    mon.storageBound = true;
    const logAlreadyBound = !!mon.logClosed;
    mon.logClosed ??= mon.logStream.closed
      ? Promise.resolve()
      : new Promise((resolve) => mon.logStream.once("close", resolve));
    if (!mon.legacy && !logAlreadyBound)
      mon.logStream.on("error", (error) => {
        mon.logError = error;
        stop_repeat(mon);
        finishActivity(`monitor:${mon.logPath}`, "failed", { log_error: 1 });
      });
    void mon.logClosed
      .then(() => {
        if (mon.legacy) {
          mon.running = false;
          clearTimeout(mon.timeout);
          clearTimeout(mon.nextTimer);
          watch_legacy_stop(mon);
        }
      })
      .catch((error) => repeat_pending(mon, error));
  }
  if (!mon.operation || mon.abort) return;
  mon.abort = () => {
    void join_repeat_shutdown(mon).catch(() => {});
  };
  mon.operation.signal.addEventListener("abort", mon.abort, { once: true });
  if (mon.operation.signal.aborted) mon.abort();
}
