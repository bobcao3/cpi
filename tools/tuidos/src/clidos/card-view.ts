import { listAllTaskIds, type TaskRow } from "../core/tasks";
import { listColumns, type ColumnRow } from "../core/columns";
import { listAllMessageIds, type MessageRow } from "../core/messages";
import { listMediaForTask, type MediaRow } from "../core/media";
import { listAllTopics, type TopicRow } from "../core/topics";
import { matchIdPrefix } from "../core/id";
import { uid } from "./uid";
import { fail } from "./audit-view";
import { accent, muted, bold, ok, note, relativeTime, padAccent, heading } from "./format";

// --- resolution (id or unambiguous id prefix; names where unique) ---

/** Resolve a task reference: exact id or an unambiguous id prefix. Tasks have
 *  no names (titles aren't unique), so resolution is by id only. */
export function resolveTaskId(projectId: string, arg: string): string {
  if (!arg) fail("task id is required");
  const ids = listAllTaskIds(projectId);
  if (ids.includes(arg)) return arg;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous task id prefix '${arg}' — matches ${pm.length} tasks`);
  if (pm[0]) return pm[0];
  fail(`no task '${arg}' in this project`);
}

/** Resolve a column reference: exact id, exact name, an unambiguous id prefix,
 *  or a case-insensitive name (column names are unique). */
export function resolveColumnId(projectId: string, arg: string): string {
  if (!arg) fail("column id or name is required");
  const cols = listColumns(projectId);
  if (cols.length === 0) fail("project has no columns");
  const ids = cols.map((c) => c.id);
  if (ids.includes(arg)) return arg;
  const exact = cols.find((c) => c.name === arg);
  if (exact) return exact.id;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous column id prefix '${arg}'`);
  if (pm[0]) return pm[0];
  const lower = arg.toLowerCase();
  const ci = cols.filter((c) => c.name.toLowerCase() === lower);
  if (ci.length > 1) fail(`ambiguous column name '${arg}'`);
  if (ci[0]) return ci[0].id;
  fail(`no column '${arg}'`);
}

/** Resolve a message reference on a task: exact id or an unambiguous prefix. */
export function resolveMessageId(projectId: string, taskId: string, arg: string): string {
  if (!arg) fail("message id is required");
  const ids = listAllMessageIds(projectId, taskId);
  if (ids.includes(arg)) return arg;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous message id prefix '${arg}'`);
  if (pm[0]) return pm[0];
  fail(`no message '${arg}' on this task`);
}

/** Resolve a media reference on a task: exact id or an unambiguous prefix. */
export function resolveMediaId(projectId: string, taskId: string, arg: string): string {
  if (!arg) fail("media id is required");
  const ids = listMediaForTask(projectId, taskId).map((m) => m.id);
  if (ids.includes(arg)) return arg;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous media id prefix '${arg}'`);
  if (pm[0]) return pm[0];
  fail(`no media '${arg}' on this task`);
}

// --- rendering ---

function columnMap(columns: ColumnRow[]): Map<string, string> {
  return new Map(columns.map((c) => [c.id, c.name]));
}

function priorityLabel(p: number | null): string {
  if (p == null || p === 0) return "";
  return ["", "low", "med", "high", "urgent"][p] ?? `p${p}`;
}

function dueDate(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Resolve a topic reference: exact id, exact name, an unambiguous id prefix,
 *  or a case-insensitive name (topic names are unique per project). Resolves to
 *  active OR archived topics — callers needing active validate separately. */
export function resolveTopicId(projectId: string, arg: string): string {
  if (!arg) fail("topic id or name is required");
  const topics = listAllTopics(projectId);
  const ids = topics.map((t) => t.id);
  if (ids.includes(arg)) return arg;
  const exact = topics.find((t) => t.name === arg);
  if (exact) return exact.id;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous topic id prefix '${arg}' — matches ${pm.length} (use more characters)`);
  if (pm[0]) return pm[0];
  const lower = arg.toLowerCase();
  const ci = topics.filter((t) => t.name.toLowerCase() === lower);
  if (ci.length > 1) fail(`ambiguous topic name '${arg}'`);
  if (ci[0]) return ci[0].id;
  fail(`no topic '${arg}' in this project`);
}

/** Render a task list: title (accent) + id (muted) + column + status badges. */
export function renderTaskList(tasks: TaskRow[], columns: ColumnRow[]): string {
  if (tasks.length === 0) return muted("  (no tasks)");
  const cmap = columnMap(columns);
  const ids = tasks.map((t) => t.id);
  const width = Math.max(8, ...tasks.map((t) => t.title.length));
  return tasks
    .map((t) => {
      const col = muted(cmap.get(t.column_id) ?? "?");
      const id = uid(t.id, ids);
      const badges: string[] = [];
      if (t.completed_at != null) badges.push(ok("✓"));
      const pl = priorityLabel(t.priority);
      if (pl) badges.push(muted(`!${pl}`));
      if (t.assignee) badges.push(muted(`@${t.assignee}`));
      const due = dueDate(t.due_at);
      if (due) badges.push(muted(`due ${due}`));
      const b = badges.length ? `  ${badges.join(" ")}` : "";
      return `  ${padAccent(t.title, width)}  ${id}  ${col}${b}`;
    })
    .join("\n");
}

/** Render a card detail view: header + summary + thread (body first) + media. */
export function renderTaskShow(
  task: TaskRow,
  messages: MessageRow[],
  media: MediaRow[],
  columns: ColumnRow[],
 topics: TopicRow[],
 taskIds: string[],
): string {
  const cmap = columnMap(columns);
  const lines: string[] = [];
  lines.push(heading(task.title));
  lines.push(`  ${muted("id")} ${uid(task.id, taskIds)}  ${muted("column")} ${accent(cmap.get(task.column_id) ?? "?")}`);
  if (topics.length > 0) {
    lines.push(`  ${muted("topics")} ${topics.map((t) => accent(t.name)).join("  ")}`);
  }
  const meta: string[] = [];
  if (task.completed_at != null) meta.push(ok("✓ done"));
  const pl = priorityLabel(task.priority);
  if (pl) meta.push(`priority ${pl}`);
  if (task.assignee) meta.push(`@${task.assignee}`);
  const due = dueDate(task.due_at);
  if (due) meta.push(`due ${due}`);
  if (meta.length) lines.push(`  ${muted(meta.join("   "))}`);
  if (task.description) {
    lines.push("");
    lines.push(task.description);
  }
  if (messages.length > 0) {
    lines.push("");
    lines.push(bold("Thread"));
    lines.push(renderThread(messages));
  }
  if (media.length > 0) {
    lines.push("");
    lines.push(bold("Media"));
    lines.push(renderMediaList(media));
  }
  return lines.join("\n");
}

/** Render a thread (body first, then replies). */
export function renderThread(messages: MessageRow[]): string {
  if (messages.length === 0) return muted("  (no messages)");
  const lines: string[] = [];
  messages.forEach((m, i) => {
    const role = i === 0 ? accent("body") : muted("reply");
    const who = muted(m.author ?? "anon");
    lines.push(`  ${role}  ${who}  ${muted(relativeTime(m.created_at))}`);
    lines.push(`  ${m.content}`);
  });
  return lines.join("\n");
}

/** Render a media list: filename + id + hash prefix + size. */
export function renderMediaList(media: MediaRow[]): string {
  if (media.length === 0) return muted("  (no media)");
  const ids = media.map((m) => m.id);
  return media
    .map((m) => `  ${accent(m.filename)}  ${uid(m.id, ids)}  ${muted(m.content_hash.slice(0, 10))}  ${muted(`${m.size_bytes}B`)}`)
    .join("\n");
}
/** Render a task's topics as accent labels (or a muted placeholder). */
export function renderTaskTopics(topics: TopicRow[]): string {
  if (topics.length === 0) return muted("  (no topics)");
  return `  ${topics.map((t) => accent(t.name)).join("  ")}`;
}

/** ✓ Tagged task with <topic> — or a note if it was already attached. */
export function renderTopicAttached(name: string, attached: boolean): string {
  return attached
    ? `${ok("✓")} Tagged task with ${accent(name)}`
    : note(`task already tagged with ${name}`);
}

/** ✓ Untagged task from <topic> — or a note if it wasn't attached. */
export function renderTopicDetached(name: string, detached: boolean): string {
  return detached
    ? `${ok("✓")} Untagged task from ${accent(name)}`
    : note(`topic '${name}' was not attached to this task`);
}

// --- one-line confirmations ---

export function renderTaskCreated(title: string, id: string): string {
  return `${ok("✓")} Created task ${accent(title)} (${id})`;
}
export function renderTaskMoved(label: string, column: string): string {
  return `${ok("✓")} Moved ${accent(label)} → ${accent(column)}`;
}
export function renderTaskUpdated(label: string): string {
  return `${ok("✓")} Updated task ${accent(label)}`;
}
export function renderTaskCompleted(label: string): string {
  return `${ok("✓")} Completed task ${accent(label)}`;
}
export function renderTaskReopened(label: string): string {
  return `${ok("✓")} Reopened task ${accent(label)}`;
}
export function renderTaskArchived(title: string): string {
  return `${ok("✓")} Archived task ${accent(title)}`;
}
export function renderTaskRestored(title: string, column: string, relocated: boolean): string {
  return relocated
    ? `${ok("✓")} Restored task ${accent(title)} (moved to ${accent(column)})`
    : `${ok("✓")} Restored task ${accent(title)}`;
}
export function renderMessageAdded(id: string): string {
  return `${ok("✓")} Added message (${id})`;
}
export function renderMessageEdited(): string {
  return `${ok("✓")} Edited message`;
}
export function renderMessageArchived(): string {
  return `${ok("✓")} Archived message`;
}
export function renderMediaAdded(filename: string, id: string): string {
  return `${ok("✓")} Attached ${accent(filename)} (${id})`;
}
export function renderMediaRemoved(filename: string): string {
  return `${ok("✓")} Removed media ${accent(filename)}`;
}
export function renderMediaExported(filename: string, dest: string): string {
  return `${ok("✓")} Exported ${accent(filename)} → ${muted(dest)}`;
}

/** Render a column list: position + name + task count + id. */
export function renderColumnList(columns: ColumnRow[], counts: Map<string, number>): string {
  if (columns.length === 0) return muted("  (no columns)");
  const ids = columns.map((c) => c.id);
  const width = Math.max(8, ...columns.map((c) => c.name.length));
  return columns
    .map((c, i) => {
      const n = counts.get(c.id) ?? 0;
      const cnt = muted(`${n} task${n === 1 ? "" : "s"}`);
     return `  ${muted(String(i).padStart(2))}  ${padAccent(c.name, width)}  ${cnt}  ${uid(c.id, ids)}`;
    })
    .join("\n");
}

export function renderColumnCreated(name: string, id: string): string {
  return `${ok("✓")} Created column ${accent(name)} (${id})`;
}
export function renderColumnRenamed(oldName: string, newName: string): string {
  return `${ok("✓")} Renamed column ${muted(oldName)} → ${accent(newName)}`;
}
export function renderColumnMoved(name: string, position: number): string {
  return `${ok("✓")} Moved column ${accent(name)} to position ${position}`;
}
export function renderColumnArchived(name: string): string {
  return `${ok("✓")} Archived column ${accent(name)}`;
}
