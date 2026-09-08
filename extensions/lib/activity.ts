import { constants } from "node:fs";
import { open } from "node:fs/promises";

export type ActivityKind = "shell" | "monitor" | "subagent";
export interface ActivityEntry {
  id: string;
  kind: ActivityKind;
  status:
    | "running"
    | "stopping"
    | "completed"
    | "failed"
    | "cancelled"
    | "detached";
  session_id?: string;
  label: string;
  command?: string;
  cwd?: string;
  started_at: number;
  ended_at?: number;
  log_path?: string;
  tail?: string;
  metrics?: Record<string, string | number>;
}
const KEY = "__cpiActivities";
const TAIL_BYTES = 32768;
const ACTIVE_LIMIT = 256;
const HISTORY_LIMIT = 256;
export function setActivitySession(session_id?: string): void {
  (globalThis as Record<string, unknown>).__cpiActivitySession = session_id;
}
export function getActivitySession(): string | undefined {
  return (globalThis as Record<string, unknown>).__cpiActivitySession as
    | string
    | undefined;
}
function entries(): Map<string, ActivityEntry> {
  const globals = globalThis as Record<string, unknown>;
  return (globals[KEY] ??= new Map()) as Map<string, ActivityEntry>;
}
function live(entry: ActivityEntry): boolean {
  return entry.status === "running" || entry.status === "stopping";
}
export function sanitizeActivityText(text: string): string {
  return text
    .replace(
      /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\|$)|\[[0-?]*[ -/]*[@-~]|[PX^_][\s\S]*?(?:\x1b\\|$)|[@-_])/g,
      "",
    )
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}
function bounded(text: string, bytes = TAIL_BYTES): string {
  const buffer = Buffer.from(text);
  let start = Math.max(0, buffer.length - bytes);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return sanitizeActivityText(buffer.subarray(start).toString("utf8"));
}
function clean(entry: ActivityEntry): ActivityEntry {
  for (const value of [entry.id, entry.session_id, entry.cwd, entry.log_path]) {
    if (value && value.length > 4096)
      throw new Error("activity metadata limit");
  }
  const metrics = Object.fromEntries(
    Object.entries(entry.metrics ?? {})
      .slice(0, 32)
      .map(([key, value]) => [
        bounded(key, 64),
        typeof value === "string" ? bounded(value, 1024) : value,
      ]),
  );
  return {
    ...entry,
    label: bounded(entry.label, 1024),
    command: entry.command && bounded(entry.command, 8192),
    tail: entry.tail && bounded(entry.tail),
    metrics,
  };
}
function trimHistory(map: Map<string, ActivityEntry>): void {
  const terminal = [...map.values()]
    .filter((entry) => !live(entry))
    .sort(
      (a, b) => (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at),
    );
  for (const entry of terminal.slice(HISTORY_LIMIT)) map.delete(entry.id);
}
export function beginActivity(entry: ActivityEntry): void {
  try {
    const map = entries();
    if (map.has(entry.id)) return;
    if (live(entry) && [...map.values()].filter(live).length >= ACTIVE_LIMIT)
      return;
    map.set(entry.id, clean(entry));
    if (!live(entry)) trimHistory(map);
  } catch {}
}
export function updateActivity(
  id: string,
  patch: Partial<ActivityEntry>,
): void {
  try {
    const map = entries();
    const previous = map.get(id);
    if (!previous) return;
    if (!live(previous) && patch.status && live({ ...previous, ...patch }))
      return;
    map.set(
      id,
      clean({
        ...previous,
        ...patch,
        id,
        metrics: { ...previous.metrics, ...patch.metrics },
      }),
    );
    if (patch.status && !live({ ...previous, ...patch })) trimHistory(map);
  } catch {}
}
export function appendActivityTail(id: string, text: string): void {
  try {
    const entry = entries().get(id);
    if (entry)
      updateActivity(id, {
        tail: bounded((entry.tail ?? "") + text),
        metrics: { last_output_at: Date.now() },
      });
  } catch {}
}
export function finishActivity(
  id: string,
  status: ActivityEntry["status"],
  metrics?: ActivityEntry["metrics"],
): void {
  try {
    const entry = entries().get(id);
    if (!entry || !live(entry)) return;
    updateActivity(id, { status, ended_at: Date.now(), metrics });
  } catch {}
}
export function listActivities(session_id?: string): ActivityEntry[] {
  return [...entries().values()]
    .filter(
      (entry) => session_id === undefined || entry.session_id === session_id,
    )
    .sort((a, b) => {
      if (live(a) !== live(b)) return live(a) ? -1 : 1;
      return live(a)
        ? a.started_at - b.started_at
        : (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at);
    })
    .map((entry) => ({ ...entry, metrics: { ...entry.metrics } }));
}
export async function readActivityTail(entry: ActivityEntry): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (entry.log_path) {
      file = await open(
        entry.log_path,
        constants.O_RDONLY | constants.O_NONBLOCK,
      );
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("not a regular file");
      const length = Math.min(stat.size, TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(
        buffer,
        0,
        length,
        Math.max(0, stat.size - length),
      );
      return bounded(buffer.subarray(0, bytesRead).toString("utf8"));
    }
  } catch {
  } finally {
    await file?.close().catch(() => {});
  }
  return bounded(
    entry.tail ||
      (entry.log_path
        ? "Log unavailable (missing or not a regular file)."
        : "No output yet."),
  );
}
