import { record_shell_shutdown } from "./shutdown.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import {
  captureSessionOwner,
  createSessionOwner,
  type SessionOwner,
} from "../lib/storage/owner.ts";
import { adopt_repeat_storage } from "./repeat-lifecycle.ts";
import { joinRepeatsForShutdown } from "./repeat.ts";
import { hostCodingAgent } from "../../bin/host-pi.mjs";
import type { RepeatMonitor } from "./background-types.ts";
import type { ShellProfile } from "./profile.ts";
import { NOTIFICATION_TYPE, wrapNotification } from "../lib/notification.ts";
import { loadText, render, textPath } from "../lib/text.ts";

export const REPEAT_ENTRY = "cpi-repeat";
export interface RepeatRecord {
  version: 1;
  id: string;
  scope: string;
  artifact_owner?: SessionOwner;
  command: string;
  cwd: string;
  shell: Pick<
    ShellProfile,
    "executable" | "argvPrefix" | "dialect" | "displayName"
  >;
  env_file?: string;
  interval: number;
  log_path: string;
  description?: string;
  started_at: number;
  updated_at: number;
  status: "running" | "stopped" | "breach" | "shutdown" | "interrupted";
  exit_code?: number | null;
  acknowledged_at?: number;
}
interface PersistenceState {
  records: Map<string, RepeatRecord>;
  writers: Map<string, (record: RepeatRecord) => boolean>;
  pending: Map<string, RepeatRecord>;
  reloading: Set<string>;
}
const shared = globalThis as typeof globalThis & {
  __cpiRepeatPersistence?: PersistenceState;
};
const state: PersistenceState = (shared.__cpiRepeatPersistence ??= {
  records: new Map(),
  writers: new Map(),
  pending: new Map(),
  reloading: new Set(),
});

function persist(record: RepeatRecord): void {
  state.records.set(record.id, record);
  if (
    !state.reloading.has(record.scope) &&
    state.writers.get(record.scope)?.(record)
  )
    state.pending.delete(record.id);
  else state.pending.set(record.id, record);
}

export async function suspendRepeatWrites(
  ctx: ExtensionContext,
  reason: string,
): Promise<void> {
  if (reason === "reload")
    state.reloading.add(ctx.sessionManager.getSessionId());
  if (reason === "quit")
    await joinRepeatsForShutdown(ctx.sessionManager.getSessionId());
}

export function recordRepeatStart(mon: RepeatMonitor, env_file?: string): void {
  if (!mon.sessScope) return;
  const { executable, argvPrefix, dialect, displayName } = mon.shell;
  const now = Date.now();
  persist({
    version: 1,
    id: mon.id,
    scope: mon.sessScope,
    artifact_owner: mon.owner,
    command: mon.command,
    cwd: mon.cwd,
    shell: { executable, argvPrefix, dialect, displayName },
    env_file,
    interval: mon.intervalSec,
    log_path: mon.logPath,
    description: mon.describe,
    started_at: now,
    updated_at: now,
    status: "running",
  });
}

export function recordRepeatTerminal(
  mon: RepeatMonitor,
  status: "stopped" | "breach" | "shutdown",
  exit_code: number | null = null,
): boolean {
  const record = state.records.get(mon.id);
  if (!record) return false;
  if (record.status !== "running") return !state.pending.has(mon.id);
  persist({ ...record, status, exit_code, updated_at: Date.now() });
  const durable = !state.pending.has(mon.id);
  if (status === "shutdown" && !durable) {
    persist({ ...state.records.get(mon.id)!, acknowledged_at: Date.now() });
  }
  return durable;
}

export function getRepeatHistory(ctx: ExtensionContext): RepeatRecord[] {
  const records = new Map<string, RepeatRecord>();
  const entries = ctx.sessionManager.getEntries();
  if (entries.length > 100_000)
    throw new Error("Repeat history entry limit exceeded");
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== REPEAT_ENTRY) continue;
    const record = entry.data as RepeatRecord | undefined;
    if (record?.version === 1 && typeof record.id === "string")
      records.set(record.id, record);
  }
  return [...records.values()];
}

export async function resumeRepeatMonitors(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  monitors: ReadonlyMap<string, RepeatMonitor>,
  notify = true,
  owner?: SessionOwner,
): Promise<void> {
  const manager = ctx.sessionManager;
  const scope = manager.getSessionId();
  const session_file = manager.getSessionFile();
  const captured_owner = Object.freeze({
    ...(owner ?? captureSessionOwner(manager, join(getAgentDir(), "jobs"))),
  });
  const history = getRepeatHistory(ctx);
  const records = new Map(history.map((record) => [record.id, record]));
  for (const mon of monitors.values()) {
    if (mon.operation) continue;
    const recorded =
      records.get(mon.id)?.artifact_owner ??
      state.records.get(mon.id)?.artifact_owner;
    const inherited =
      mon.env.CPI_ARTIFACT_SESSION_ID && mon.env.CPI_ARTIFACT_SESSION_DIR
        ? createSessionOwner(
            mon.env.CPI_ARTIFACT_SESSION_ID,
            mon.env.CPI_ARTIFACT_SESSION_DIR,
          )
        : undefined;
    const artifact_owner =
      mon.owner ??
      recorded ??
      inherited ??
      (mon.sessScope && mon.sessScope !== scope
        ? captureSessionOwner(
            {
              getSessionId: () => mon.sessScope!,
              getSessionDir: () => mon.env.PI_SESSION_DIR ?? "",
            },
            join(getAgentDir(), "jobs"),
          )
        : captured_owner);
    adopt_repeat_storage(mon, artifact_owner);
  }
  const { SessionManager } = await hostCodingAgent();
  state.writers.set(scope, (record) => {
    const append_inactive = () => {
      if (!session_file) return false;
      SessionManager.open(session_file).appendCustomEntry(REPEAT_ENTRY, record);
      return true;
    };
    if (manager.getSessionId() !== scope) return append_inactive();
    try {
      pi.appendEntry(REPEAT_ENTRY, record);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        /stale after session replacement or reload/.test(error.message)
      )
        return append_inactive();
      throw error;
    }
  });
  state.reloading.delete(scope);
  for (const record of history) {
    if (record.artifact_owner) state.records.set(record.id, record);
    else
      persist({
        ...record,
        artifact_owner: monitors.get(record.id)?.owner ?? captured_owner,
      });
  }
  for (const mon of monitors.values()) {
    const record = state.records.get(mon.id);
    if (record && !record.artifact_owner && mon.owner)
      persist({ ...record, artifact_owner: mon.owner });
  }
  for (const record of [...state.pending.values()]) {
    if (record.scope === scope) persist(record);
  }
  if (!notify) return;
  const text = loadText<{ interrupted: { summary: string; guidance: string } }>(
    "repeat-persistence",
    textPath("repeat-persistence"),
  ).interrupted;
  for (const record of state.records.values()) {
    if (record.scope !== scope || record.acknowledged_at) continue;
    if (record.status !== "running" && record.status !== "shutdown") continue;
    const live = monitors.get(record.id);
    if (live?.running) continue;
    const now = Date.now();
    const interrupted: RepeatRecord = {
      ...record,
      status: "interrupted",
      updated_at: now,
      acknowledged_at: now,
    };
    const summary = render(text.summary, { ...interrupted });
    const details = {
      kind: "interrupted-shells" as const,
      summary,
      payload: { ...interrupted, summary, guidance: text.guidance },
    };
    const delivered = () =>
      manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === NOTIFICATION_TYPE &&
            (entry.details as { kind?: string } | undefined)?.kind ===
              "interrupted-shells" &&
            (entry.details as { payload?: { id?: string } } | undefined)
              ?.payload?.id === record.id,
        );
    if (!delivered())
      pi.sendMessage({
        customType: NOTIFICATION_TYPE,
        content: wrapNotification(details),
        display: true,
        details,
      });
    if (delivered()) persist(interrupted);
  }
}

export function recordRepeatShutdown(mon: RepeatMonitor): void {
  if (!recordRepeatTerminal(mon, "shutdown"))
    record_shell_shutdown(mon.env.PI_SESSION_DIR, mon.sessScope, {
      id: mon.id,
      command: mon.command,
      describe: mon.describe,
      log_path: mon.logPath,
      kind: "repeat",
    });
}
