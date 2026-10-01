import { existsSync } from "node:fs";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { hostCodingAgent } from "../../bin/host-pi.mjs";
import type { ShellDialect } from "./profile.ts";
import type { BackgroundChild } from "./background-types.ts";
import { beginActivity } from "../lib/activity.ts";
import { readTarget } from "./ghostmux.ts";

export const SHELL_ENTRY = "cpi-shell";
export class ShellIdentityError extends Error {}
export interface ShellRecord {
  version: 1;
  id: string;
  scope: string;
  pid: string;
  command: string;
  cwd?: string;
  describe?: string;
  dialect?: ShellDialect;
  logPath: string;
  statePath: string;
  socketPath?: string;
  uid?: string;
  serverPid?: number;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "detached"
    | "shutdown"
    | "lost";
  cancelRequested?: boolean;
  noticeSuppressed?: boolean;
  exitCode?: number;
  outputBytes?: number;
  acknowledgedAt?: number;
  legacyPath?: string;
  legacyDeliveryId?: string;
}
interface PersistenceState {
  records: Map<string, ShellRecord>;
  writers: Map<string, (record: ShellRecord) => boolean>;
  pending: Map<string, ShellRecord>;
  reloading: Set<string>;
}
const shared = globalThis as typeof globalThis & {
  __cpiShellPersistence?: PersistenceState;
};
const state = (shared.__cpiShellPersistence ??= {
  records: new Map(),
  writers: new Map(),
  pending: new Map(),
  reloading: new Set(),
});

function cacheShellRecord(record: ShellRecord): void {
  const existing = state.records.get(record.id);
  if (existing && existing.scope !== record.scope)
    throw new ShellIdentityError("Shell resource ownership changed");
  if (state.records.size >= 100_000 && !existing)
    throw new Error("Shell lifecycle record limit exceeded");
  state.records.set(record.id, record);
}

export function shellHistory(ctx: ExtensionContext): ShellRecord[] {
  const entries = ctx.sessionManager.getEntries();
  if (entries.length > 100_000)
    throw new Error("Shell history entry limit exceeded");
  const records = new Map<string, ShellRecord>();
  const scope = ctx.sessionManager.getSessionId();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SHELL_ENTRY) continue;
    const record = entry.data as ShellRecord | undefined;
    if (record?.version !== 1 || record.scope !== scope) continue;
    if (
      typeof record.id !== "string" ||
      typeof record.pid !== "string" ||
      typeof record.command !== "string" ||
      typeof record.logPath !== "string" ||
      typeof record.statePath !== "string"
    )
      throw new Error("Invalid shell lifecycle record");
    records.set(record.id, record);
  }
  return [...records.values()];
}

export function shellRecords(scope: string): ShellRecord[] {
  return [...state.records.values()].filter((record) => record.scope === scope);
}

export async function shellTarget(record: ShellRecord) {
  const target = await readTarget(record.statePath);
  if (
    target.scope !== record.scope ||
    target.pid !== Number(record.pid) ||
    (record.uid !== undefined && target.uid !== record.uid) ||
    (record.serverPid !== undefined && target.serverPid !== record.serverPid) ||
    (record.socketPath !== undefined && target.socketPath !== record.socketPath)
  )
    throw new ShellIdentityError("Shell resource ownership changed");
  return target;
}

export function writeShellRecord(record: ShellRecord): void {
  cacheShellRecord(record);
  state.pending.set(record.id, record);
  const writer = state.writers.get(record.scope);
  if (writer && !state.reloading.has(record.scope) && writer(record)) {
    state.pending.delete(record.id);
  }
}

export function updateShellRecord(
  id: string,
  patch: Partial<ShellRecord>,
): void {
  const record = state.records.get(id);
  if (record)
    writeShellRecord({
      ...record,
      ...patch,
      id: record.id,
      scope: record.scope,
      updatedAt: Date.now(),
    });
}

export function recordShellStart(entry: BackgroundChild, cwd: string): void {
  if (!entry.sessScope) return;
  const target = entry.client.target;
  if (!target || target.scope !== entry.sessScope || target.pid !== entry.pid)
    throw new ShellIdentityError("Shell resource ownership changed");
  writeShellRecord({
    version: 1,
    id: entry.activityId,
    scope: entry.sessScope,
    pid: entry.id,
    command: entry.command,
    cwd,
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
  });
}

export function recordShellEnd(
  entry: BackgroundChild,
  status: ShellRecord["status"],
  exitCode?: number,
  acknowledged = false,
): void {
  const record = state.records.get(entry.activityId);
  if (!record || record.status !== "running") return;
  updateShellRecord(record.id, {
    status,
    endedAt: Date.now(),
    exitCode,
    outputBytes: entry.bytesEmitted,
    ...(acknowledged ? { acknowledgedAt: Date.now() } : {}),
  });
}

export function suspendShellWrites(
  ctx: ExtensionContext,
  reason: string,
): void {
  if (reason === "reload")
    state.reloading.add(ctx.sessionManager.getSessionId());
}

export async function bindShellPersistence(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const { SessionManager } = await hostCodingAgent();
  const manager = ctx.sessionManager;
  const scope = manager.getSessionId();
  const file = manager.getSessionFile();
  if (state.writers.size >= 100_000 && !state.writers.has(scope))
    throw new Error("Shell session writer limit exceeded");
  state.writers.set(scope, (record) => {
    const inactive = () => {
      if (!file || !existsSync(file)) {
        return false;
      }
      const owner = SessionManager.open(file);
      if (owner.getSessionId() !== scope)
        throw new Error("Shell session ownership changed");
      owner.appendCustomEntry(SHELL_ENTRY, record);
      return true;
    };
    if (manager.getSessionId() !== scope) return inactive();
    try {
      pi.appendEntry(SHELL_ENTRY, record);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        /stale after session replacement or reload/.test(error.message)
      )
        return inactive();
      throw error;
    }
  });
  for (const record of shellHistory(ctx)) cacheShellRecord(record);
  state.reloading.delete(scope);
  for (const record of [...state.pending.values()]) {
    if (record.scope === scope) writeShellRecord(record);
  }
}

export function restoreShellActivities(scope: string): void {
  for (const record of shellRecords(scope)) {
    const status =
      record.status === "shutdown"
        ? "cancelled"
        : record.status === "lost"
          ? "failed"
          : record.status === "running" && record.cancelRequested
            ? "stopping"
            : record.status;
    beginActivity({
      id: record.id,
      session_id: scope,
      kind: "shell",
      status,
      label: record.describe || record.command,
      command: record.command,
      cwd: record.cwd,
      started_at: record.startedAt,
      ended_at:
        record.status === "running"
          ? undefined
          : (record.endedAt ?? record.updatedAt),
      log_path: record.logPath,
      metrics: {
        pid: Number(record.pid),
        ...(record.outputBytes === undefined
          ? {}
          : { output_bytes: record.outputBytes }),
        ...(record.exitCode === undefined
          ? {}
          : { exit_code: record.exitCode }),
        ...(record.dialect ? { syntax: record.dialect } : {}),
      },
    });
  }
}

export interface ResumeRecord {
  id: string;
  pid: string;
  sockPath: string;
  cmd: string;
  logPath?: string;
  describe?: string;
  dialect?: ShellDialect;
  cwd?: string;
  startedAt?: number;
}
export interface CompletedRecord {
  id: string;
  deliveryId?: string;
  pid: string;
  command: string;
  exitCode: number;
  logPath: string;
  completedAt: number;
}
export async function readResumeRecords(
  _directory: string,
  scope: string,
): Promise<ResumeRecord[]> {
  return shellRecords(scope)
    .filter((record) => record.status === "running")
    .map((record) => ({
      id: record.id,
      pid: record.pid,
      sockPath: record.statePath,
      cmd: record.command,
      logPath: record.logPath,
      describe: record.describe,
      dialect: record.dialect,
      cwd: record.cwd,
      startedAt: record.startedAt,
    }));
}
export async function writeCompletedRecord(
  scope: string,
  completed: CompletedRecord,
): Promise<void> {
  const previous = shellRecords(scope).find(
    (record) => record.id === completed.id,
  );
  if (!previous) throw new Error("Shell completion record not found");
  if (previous.status !== "running") return;
  writeShellRecord({
    ...previous,
    command: completed.command,
    logPath: completed.logPath,
    exitCode: completed.exitCode,
    endedAt: completed.completedAt,
    updatedAt: completed.completedAt,
    ...(previous.noticeSuppressed
      ? { acknowledgedAt: completed.completedAt }
      : {}),
    status: previous.cancelRequested
      ? "cancelled"
      : completed.exitCode === 0
        ? "completed"
        : "failed",
  });
}
export async function readCompletedRecords(
  _directory: string,
  scope: string,
): Promise<CompletedRecord[]> {
  return shellRecords(scope)
    .filter(
      (record) =>
        (record.status === "completed" ||
          record.status === "failed" ||
          record.status === "cancelled") &&
        !record.acknowledgedAt,
    )
    .map((record) => ({
      id: record.id,
      deliveryId: record.legacyDeliveryId,
      pid: record.pid,
      command: record.command,
      exitCode: record.exitCode ?? -1,
      logPath: record.logPath,
      completedAt: record.endedAt ?? record.updatedAt,
    }));
}
export function acknowledgeShellRecord(scope: string, id: string): void {
  const record = shellRecords(scope).find(
    (record) =>
      record.id === id && !record.acknowledgedAt && record.status !== "running",
  );
  if (record) updateShellRecord(record.id, { acknowledgedAt: Date.now() });
}
