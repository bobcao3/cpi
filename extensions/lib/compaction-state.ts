/** Read-only runtime snapshot for compaction: JSON-safe facts only, no prose, no resource revival. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { listActivities, type ActivityEntry } from "./activity.ts";
import { getCwd } from "./cwd.ts";

export interface ModelSnapshot {
  provider: string;
  modelId: string;
}

export interface GoalSnapshot {
  objective: string | null;
  active: boolean;
  paused: boolean;
  turnCount: number;
  startedAtMs: number | null;
}

export interface AlarmSnapshot {
  id: string;
  targetMs: number;
  message?: string;
}

export interface ShellSnapshot {
  id: string;
  status: "running" | "stopping";
  startedAt: number;
  logPath?: string;
}

export interface RepeatSnapshot {
  id: string;
  status: "running" | "stopping";
  startedAt: number;
  intervalSec?: number;
  logPath?: string;
}

export interface SubagentSnapshot {
  id: string;
  sessionId?: string;
  sessionFile?: string;
  logPath?: string;
  status: "running" | "stopping";
  startedAt: number;
  label?: string;
  model?: string;
  role?: string;
}

export interface EnvironmentSnapshot {
  path: string;
  tools: string[];
}

export interface RuntimeSnapshot {
  model?: ModelSnapshot;
  cwd: string;
  goal?: GoalSnapshot;
  alarms: AlarmSnapshot[];
  shells: ShellSnapshot[];
  repeats: RepeatSnapshot[];
  subagents: SubagentSnapshot[];
  environments: EnvironmentSnapshot[];
}

interface AlarmRecord {
  id: string;
  targetMs: number;
  message?: string;
  fired: boolean;
}

const MAX_LIST = 64;
const SCAN_LIMIT = 200_000;
const GOAL_STATE_ENTRY = "goal-state";
const ALARM_STATE_ENTRY = "alarm-state";
const CWD_STATE_ENTRY = "cwd-state";
const ALARM_TOOL = "alarm";
const ENV_TOOLS = new Set(["sh", "sh_repeat_until", "lsp"]);
const LIVE = new Set(["running", "stopping"]);
const RPT_LOG = /pi-rpt-output-(rpt-\d+)-/;

function branchOf(ctx: ExtensionContext) {
  const branch = ctx.sessionManager.getBranch();
  if (!Array.isArray(branch)) throw new Error("compaction-state: no branch");
  if (branch.length > SCAN_LIMIT)
    throw new Error("compaction-state: branch exceeds 200000 entries");
  return branch;
}

function isMessage(entry: unknown): entry is { message: any } {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as any).type === "message"
  );
}

function latestState<T>(branch: unknown[], customType: string): T | undefined {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i] as any;
    if (entry?.type === "custom" && entry.customType === customType)
      return entry.data as T;
  }
  return undefined;
}

function collectGoal(branch: unknown[]): GoalSnapshot | undefined {
  const d = latestState<Partial<GoalSnapshot>>(branch, GOAL_STATE_ENTRY);
  if (!d) return undefined;
  return {
    objective: typeof d.objective === "string" ? d.objective : null,
    active: !!d.active,
    paused: !!d.paused,
    turnCount: typeof d.turnCount === "number" ? d.turnCount : 0,
    startedAtMs: typeof d.startedAtMs === "number" ? d.startedAtMs : null,
  };
}

function pendingAlarms(records: unknown): AlarmRecord[] {
  if (!Array.isArray(records)) return [];
  return records.filter(
    (a): a is AlarmRecord =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as AlarmRecord).id === "string" &&
      typeof (a as AlarmRecord).targetMs === "number" &&
      (a as AlarmRecord).fired !== true,
  );
}

function collectAlarms(branch: unknown[]): AlarmSnapshot[] {
  const fromState = latestState<{ alarms?: unknown }>(
    branch,
    ALARM_STATE_ENTRY,
  );
  let records: AlarmRecord[] = [];
  if (!fromState || !Array.isArray(fromState.alarms)) {
    for (let i = branch.length - 1; i >= 0; i--) {
      const entry = branch[i];
      if (!isMessage(entry)) continue;
      const msg = entry.message;
      if (msg?.role !== "toolResult" || msg.toolName !== ALARM_TOOL) continue;
      records = pendingAlarms(msg.details?.alarms);
      break;
    }
  } else {
    records = pendingAlarms(fromState.alarms);
  }
  if (records.length > MAX_LIST)
    throw new Error(
      `compaction-state: pending alarms ${records.length} exceed limit ${MAX_LIST}`,
    );
  return records.map((a) => ({
    id: a.id,
    targetMs: a.targetMs,
    ...(typeof a.message === "string" && a.message
      ? { message: a.message }
      : {}),
  }));
}

function collectLive(
  entries: ActivityEntry[],
  kind: ActivityEntry["kind"],
): ActivityEntry[] {
  const live = entries.filter((e) => e.kind === kind && LIVE.has(e.status));
  if (live.length > MAX_LIST)
    throw new Error(
      `compaction-state: active ${kind} count ${live.length} exceed limit ${MAX_LIST}`,
    );
  return live;
}

function collectShells(entries: ActivityEntry[]): ShellSnapshot[] {
  return collectLive(entries, "shell").map((e) => ({
    id: typeof e.metrics?.pid === "number" ? String(e.metrics.pid) : e.id,
    status: e.status as "running" | "stopping",
    startedAt: e.started_at,
    ...(e.log_path ? { logPath: e.log_path } : {}),
  }));
}

function collectRepeats(entries: ActivityEntry[]): RepeatSnapshot[] {
  return collectLive(entries, "monitor").map((e) => ({
    id: RPT_LOG.exec(e.log_path ?? "")?.[1] ?? e.id,
    status: e.status as "running" | "stopping",
    startedAt: e.started_at,
    ...(typeof e.metrics?.interval_seconds === "number"
      ? { intervalSec: e.metrics.interval_seconds }
      : {}),
    ...(e.log_path ? { logPath: e.log_path } : {}),
  }));
}

function collectSubagents(entries: ActivityEntry[]): SubagentSnapshot[] {
  return collectLive(entries, "subagent").map((e) => ({
    id: e.id,
    ...(typeof e.metrics?.child_session_id === "string"
      ? { sessionId: e.metrics.child_session_id }
      : {}),
    ...(typeof e.metrics?.session_file === "string"
      ? { sessionFile: e.metrics.session_file }
      : {}),
    ...(e.log_path ? { logPath: e.log_path } : {}),
    status: e.status as "running" | "stopping",
    startedAt: e.started_at,
    ...(e.label ? { label: e.label } : {}),
    ...(typeof e.metrics?.model === "string" ? { model: e.metrics.model } : {}),
    ...(typeof e.metrics?.role === "string" ? { role: e.metrics.role } : {}),
  }));
}

interface EnvRef {
  tool: string;
  env: string;
  cwd?: string;
}

function collectEnvironments(
  ctx: ExtensionContext,
  branch: unknown[],
): EnvironmentSnapshot[] {
  const calls = new Map<string, EnvRef>();
  const refs: EnvRef[] = [];
  let cwd: string | undefined;
  for (const entry of branch) {
    const e = entry as any;
    if (e?.type === "custom" && e.customType === CWD_STATE_ENTRY) {
      if (typeof e.data?.cwd === "string") cwd = e.data.cwd;
      continue;
    }
    if (!isMessage(e)) continue;
    const msg = e.message;
    if (msg?.role === "assistant" && Array.isArray(msg.content)) {
      for (const item of msg.content) {
        if (item?.type !== "toolCall" || !ENV_TOOLS.has(item.name)) continue;
        const env = item.arguments?.env;
        if (typeof env !== "string" || !env.trim()) continue;
        calls.set(item.id, { tool: item.name, env, cwd });
      }
    } else if (msg?.role === "toolResult" && !msg.isError) {
      const call = calls.get(msg.toolCallId);
      if (call && call.tool === msg.toolName) {
        calls.delete(msg.toolCallId);
        refs.push(call);
      }
    }
  }
  const fallback = ctx.sessionManager.getHeader()?.cwd ?? getCwd();
  const merged = new Map<string, EnvironmentSnapshot>();
  for (let i = refs.length - 1; i >= 0; i--) {
    const { tool, env, cwd: at } = refs[i];
    const path = resolve(at ?? fallback, env);
    const seen = merged.get(path);
    if (seen) {
      if (!seen.tools.includes(tool)) seen.tools.push(tool);
      continue;
    }
    if (merged.size >= MAX_LIST)
      throw new Error(
        `compaction-state: environment references exceed limit ${MAX_LIST}`,
      );
    merged.set(path, { path, tools: [tool] });
  }
  return [...merged.values()];
}

export function collectRuntimeState(ctx: ExtensionContext): RuntimeSnapshot {
  const branch = branchOf(ctx);
  const sessionId = ctx.sessionManager.getSessionId();
  const activities = listActivities(sessionId);
  const model = ctx.model;
  return {
    ...(model
      ? { model: { provider: model.provider, modelId: model.id } }
      : {}),
    cwd: getCwd(),
    goal: collectGoal(branch),
    alarms: collectAlarms(branch),
    shells: collectShells(activities),
    repeats: collectRepeats(activities),
    subagents: collectSubagents(activities),
    environments: collectEnvironments(ctx, branch),
  };
}
