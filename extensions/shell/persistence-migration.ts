import { randomUUID } from "node:crypto";
import { readFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readTarget } from "./ghostmux.ts";
import { shellState } from "./background-lifecycle.ts";
import { listActivities, rekeyActivity } from "../lib/activity.ts";
import {
  shellRecords,
  writeShellRecord,
  SHELL_ENTRY,
  type ShellRecord,
} from "./persistence.ts";

export async function migrateShellRecords(
  ctx: ExtensionContext,
): Promise<void> {
  const manager = ctx.sessionManager;
  const scope = manager.getSessionId();
  adoptBackgrounds(scope);
  if (!manager.getSessionFile()) return;
  const directory = join(manager.getSessionDir(), "sh-mon", scope);
  for (const completed of [false, true]) {
    const folder = completed ? join(directory, "done") : directory;
    let files: string[];
    try {
      files = await readdir(folder);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (files.length > 4096)
      throw new Error("Legacy shell record limit exceeded");
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const path = join(folder, file);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (bytes.length > 1024 * 1024)
        throw new Error("Legacy shell record exceeds limit");
      let legacy: any;
      try {
        legacy = JSON.parse(bytes.toString("utf8"));
      } catch {
        continue;
      }
      if (typeof legacy.pid !== "string") continue;
      if (
        completed
          ? typeof legacy.command !== "string" ||
            typeof legacy.exitCode !== "number" ||
            !Number.isFinite(legacy.completedAt)
          : typeof legacy.cmd !== "string" ||
            typeof legacy.sockPath !== "string"
      )
        continue;
      const previous = shellRecords(scope).find(
        (record) =>
          record.legacyPath === path ||
          (record.pid === legacy.pid &&
            (completed
              ? record.logPath !== "" && record.logPath === legacy.logPath
              : record.statePath === legacy.sockPath)),
      );
      let id = previous?.id;
      if (!previous) {
        const target = !completed
          ? await readTarget(legacy.sockPath).catch(() => undefined)
          : undefined;
        const now = Date.now();
        const record: ShellRecord = {
          version: 1,
          id: randomUUID(),
          scope,
          pid: legacy.pid,
          command: completed ? legacy.command : legacy.cmd,
          logPath: legacy.logPath ?? target?.logPath ?? "",
          statePath: legacy.sockPath ?? "",
          socketPath: target?.socketPath,
          uid: target?.uid,
          serverPid: target?.serverPid,
          describe: legacy.describe,
          dialect: legacy.dialect,
          startedAt: completed ? legacy.completedAt : now,
          updatedAt: completed ? legacy.completedAt : now,
          endedAt: completed ? legacy.completedAt : undefined,
          status: completed
            ? legacy.exitCode === 0
              ? "completed"
              : "failed"
            : "running",
          exitCode: completed ? legacy.exitCode : undefined,
          legacyPath: path,
          legacyDeliveryId: completed
            ? JSON.stringify([scope, legacy.pid, legacy.completedAt])
            : undefined,
        };
        writeShellRecord(record);
        id = record.id;
      } else if (completed && previous.status === "running") {
        writeShellRecord({
          ...previous,
          startedAt: Math.min(previous.startedAt, legacy.completedAt),
          status: legacy.exitCode === 0 ? "completed" : "failed",
          exitCode: legacy.exitCode,
          endedAt: legacy.completedAt,
          updatedAt: legacy.completedAt,
          legacyDeliveryId: JSON.stringify([
            scope,
            legacy.pid,
            legacy.completedAt,
          ]),
        });
      }
      const migrated = shellRecords(scope).find((record) => record.id === id);
      const activity = migrated?.logPath
        ? listActivities(scope).find(
            (activity) =>
              activity.kind === "shell" &&
              activity.log_path === migrated.logPath &&
              activity.id !== id,
          )
        : undefined;
      if (activity && id) rekeyActivity(activity.id, id);
      if (
        manager
          .getEntries()
          .some(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === SHELL_ENTRY &&
              (entry.data as ShellRecord)?.id === id,
          )
      )
        await unlink(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
    }
  }
}

function adoptBackgrounds(scope: string): void {
  for (const entry of shellState.backgrounds.values()) {
    if (entry.sessScope !== scope || entry.done) continue;
    const target = entry.client.target;
    if (!target || target.scope !== scope || target.pid !== entry.pid)
      throw new Error("Legacy shell ownership changed");
    let record = shellRecords(scope).find(
      (record) =>
        record.pid === entry.id && record.statePath === entry.client.statePath,
    );
    if (record?.id === entry.activityId) continue;
    if (
      record &&
      (record.scope !== target.scope ||
        Number(record.pid) !== target.pid ||
        (record.uid !== undefined && record.uid !== target.uid) ||
        (record.serverPid !== undefined &&
          record.serverPid !== target.serverPid) ||
        (record.socketPath !== undefined &&
          record.socketPath !== target.socketPath))
    )
      throw new Error("Legacy shell ownership changed");
    if (!record) {
      record = {
        version: 1,
        id: randomUUID(),
        scope,
        pid: entry.id,
        command: entry.command,
        cwd: listActivities(scope).find(
          (activity) => activity.id === entry.activityId,
        )?.cwd,
        describe: entry.describe,
        dialect: entry.dialect,
        logPath: entry.logPath,
        statePath: target.statePath,
        socketPath: target.socketPath,
        uid: target.uid,
        serverPid: target.serverPid,
        startedAt: entry.startedAt,
        updatedAt: Date.now(),
        status: "running",
        cancelRequested: entry.cancelRequested,
        noticeSuppressed: entry.signaled,
      };
      writeShellRecord(record);
    } else if (entry.cancelRequested || entry.signaled) {
      writeShellRecord({
        ...record,
        cancelRequested: record.cancelRequested || entry.cancelRequested,
        noticeSuppressed: record.noticeSuppressed || entry.signaled,
      });
    }
    rekeyActivity(entry.activityId, record.id);
    entry.done = true;
    entry.client.orphan();
    shellState.backgrounds.delete(entry.id);
  }
}
