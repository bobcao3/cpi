import type { Database } from "bun:sqlite";
import { openProjectRead, openProjectWrite } from "./db";
import { newId } from "./id";
import { recordAudit } from "./audit";

export interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  column_id: string;
  priority: number | null;
  assignee: string | null;
  estimate: number | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived_at: number | null;
}

export interface NewTask {
  title: string;
  description?: string | null;
  column_id?: string | null;
  priority?: number | null;
  assignee?: string | null;
  estimate?: number | null;
  due_at?: number | null;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  priority?: number | null;
  assignee?: string | null;
  estimate?: number | null;
  due_at?: number | null;
}

const ACTIVE = "archived_at IS NULL";
const TASK_COLS =
  "id, title, description, column_id, priority, assignee, estimate, due_at, created_at, updated_at, completed_at, archived_at";

function cap(s: string): string {
  return s.slice(0, 512);
}

/** Next on-board position for a card appended to `columnId` (max + 1, or 0). */
function nextPosition(db: Database, columnId: string): number {
  const row = db
    .prepare(
      `SELECT COALESCE(MAX(d.position), -1) + 1 AS p
     FROM task_display d JOIN tasks t ON t.id = d.task_id
     WHERE t.column_id = ?`,
    )
    .get(columnId) as { p: number };
  return row.p;
}

/** List a project's active tasks (optionally one column), board-ordered. */
export function listTasks(projectId: string, columnId?: string): TaskRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    const where = columnId
      ? `WHERE ${ACTIVE} AND column_id = ?`
      : `WHERE ${ACTIVE}`;
    const stmt = db.prepare(
      `SELECT ${TASK_COLS} FROM tasks ${where}
       ORDER BY (SELECT COALESCE(position, 0) FROM task_display WHERE task_id = tasks.id),
                created_at`,
    );
    return (columnId ? stmt.all(columnId) : stmt.all()) as TaskRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** All task ids in a project (active + archived), for id-prefix resolution. */
export function listAllTaskIds(projectId: string): string[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return (db.prepare("SELECT id FROM tasks").all() as { id: string }[]).map(
      (r) => r.id,
    );
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** One task by id (any state), or null. */
export function getTask(projectId: string, taskId: string): TaskRow | null {
  const db = openProjectRead(projectId);
  if (!db) return null;
  try {
    return db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`)
      .get(taskId) as TaskRow | null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Create a card. Defaults to the first column; appends to the end of it. */
export function createTask(projectId: string, t: NewTask): TaskRow {
  if (!t.title) throw new Error("title is required");
  const id = newId();
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    let columnId = t.column_id ?? null;
    db.transaction(() => {
      if (!columnId) {
        const col = db
          .prepare(
            `SELECT c.id FROM columns c LEFT JOIN column_display d ON d.column_id = c.id
           WHERE c.archived_at IS NULL
           ORDER BY COALESCE(d.position, 0), c.created_at LIMIT 1`,
          )
          .get() as { id: string } | null;
        if (!col) throw new Error("project has no columns — reinitialize it");
        columnId = col.id;
      }
      const position = nextPosition(db, columnId);
      db.prepare(
        `INSERT INTO tasks (id, title, description, column_id, priority, assignee, estimate, due_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).all(
        id,
        t.title,
        t.description ?? null,
        columnId,
        t.priority ?? null,
        t.assignee ?? null,
        t.estimate ?? null,
        t.due_at ?? null,
        now,
        now,
      );
      db.prepare(
        `INSERT INTO task_display (task_id, position) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET position = excluded.position`,
      ).all(id, position);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "task.create",
        entity_type: "task",
        entity_id: id,
        summary: cap(`created task ${t.title}`),
      });
    })();
    if (columnId == null) throw new Error("internal: no column resolved");
    return {
      id,
      title: t.title,
      description: t.description ?? null,
      column_id: columnId,
      priority: t.priority ?? null,
      assignee: t.assignee ?? null,
      estimate: t.estimate ?? null,
      due_at: t.due_at ?? null,
      created_at: now,
      updated_at: now,
      completed_at: null,
      archived_at: null,
    };
  } finally {
    db.close();
  }
}

/** Patch a task's editable fields. Only provided fields are written. */
export function updateTask(
  projectId: string,
  taskId: string,
  patch: TaskPatch,
): void {
  const fields: [keyof TaskPatch, string][] = [
    ["title", "title"],
    ["description", "description"],
    ["priority", "priority"],
    ["assignee", "assignee"],
    ["estimate", "estimate"],
    ["due_at", "due_at"],
  ];
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, col] of fields)
    if (k in patch) {
      sets.push(`${col} = ?`);
      vals.push(patch[k] ?? null);
    }
  if (sets.length === 0) return;
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(`SELECT title FROM tasks WHERE id = ? AND ${ACTIVE}`)
        .get(taskId) as { title: string } | null;
      if (!row) throw new Error(`no active task '${taskId}'`);
      db.prepare(
        `UPDATE tasks SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`,
      ).all(...vals, now, taskId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "task.update",
        entity_type: "task",
        entity_id: taskId,
        summary: cap(`updated task ${row.title}`),
      });
    })();
  } finally {
    db.close();
  }
}

/** Move a card to a column (appended to the end of it). */
export function moveTask(
  projectId: string,
  taskId: string,
  columnId: string,
): void {
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const task = db
        .prepare(`SELECT title FROM tasks WHERE id = ? AND ${ACTIVE}`)
        .get(taskId) as { title: string } | null;
      if (!task) throw new Error(`no active task '${taskId}'`);
      const col = db
        .prepare("SELECT name FROM columns WHERE id = ?")
        .get(columnId) as { name: string } | null;
      if (!col) throw new Error(`no column '${columnId}'`);
      const position = nextPosition(db, columnId);
      db.prepare(
        "UPDATE tasks SET column_id = ?, updated_at = ? WHERE id = ?",
      ).all(columnId, now, taskId);
      db.prepare(
        `INSERT INTO task_display (task_id, position) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET position = excluded.position`,
      ).all(taskId, position);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "task.move",
        entity_type: "task",
        entity_id: taskId,
        summary: cap(`moved task ${task.title} → ${col.name}`),
      });
    })();
  } finally {
    db.close();
  }
}

/** Mark a card complete (or reopen it). */
export function setTaskCompleted(
  projectId: string,
  taskId: string,
  completed: boolean,
): void {
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(
          `SELECT title, completed_at FROM tasks WHERE id = ? AND ${ACTIVE}`,
        )
        .get(taskId) as { title: string; completed_at: number | null } | null;
      if (!row) throw new Error(`no active task '${taskId}'`);
      const at = completed ? (row.completed_at ?? now) : null;
      db.prepare(
        "UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?",
      ).all(at, now, taskId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: completed ? "task.complete" : "task.uncomplete",
        entity_type: "task",
        entity_id: taskId,
        summary: cap(
          `${completed ? "completed" : "reopened"} task ${row.title}`,
        ),
      });
    })();
  } finally {
    db.close();
  }
}

/** Archive a card (soft-delete / tombstone). Returns its title. */
export function archiveTask(projectId: string, taskId: string): string {
  const now = Date.now();
  let title = "";
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(`SELECT title, archived_at FROM tasks WHERE id = ?`)
        .get(taskId) as { title: string; archived_at: number | null } | null;
      if (!row) throw new Error(`no task '${taskId}'`);
      if (row.archived_at != null)
        throw new Error(`task '${row.title}' is already archived`);
      title = row.title;
      db.prepare(
        "UPDATE tasks SET archived_at = ?, updated_at = ? WHERE id = ?",
      ).all(now, now, taskId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "task.archive",
        entity_type: "task",
        entity_id: taskId,
        summary: cap(`archived task ${title}`),
      });
    })();
  } finally {
    db.close();
  }
  return title;
}

/** Restore an archived card. Relocates if its column was archived too. */
export function unarchiveTask(
  projectId: string,
  taskId: string,
): { title: string; column: string; relocated: boolean } {
  const now = Date.now();
  let title = "";
  let column = "";
  let relocated = false;
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(`SELECT title, archived_at, column_id FROM tasks WHERE id = ?`)
        .get(taskId) as {
        title: string;
        archived_at: number | null;
        column_id: string;
      } | null;
      if (!row) throw new Error(`no task '${taskId}'`);
      if (row.archived_at == null)
        throw new Error(`task '${row.title}' is not archived`);
      title = row.title;
      const col = db
        .prepare("SELECT name, archived_at FROM columns WHERE id = ?")
        .get(row.column_id) as {
        name: string;
        archived_at: number | null;
      } | null;
      if (!col)
        throw new Error(
          `task '${title}' references a missing column — data error, report to developer`,
        );
      if (col.archived_at != null) {
        const first = db
          .prepare(
            `SELECT c.id, c.name FROM columns c LEFT JOIN column_display d ON d.column_id = c.id
           WHERE c.archived_at IS NULL
           ORDER BY COALESCE(d.position, 0), c.created_at LIMIT 1`,
          )
          .get() as { id: string; name: string } | null;
        if (!first)
          throw new Error(
            `project has no active columns to restore into — create one first: clidos -p <project> columns create <name>`,
          );
        const columnId = first.id;
        column = first.name;
        relocated = true;
        const position = nextPosition(db, columnId);
        db.prepare("UPDATE tasks SET column_id = ? WHERE id = ?").all(
          columnId,
          taskId,
        );
        db.prepare(
          `INSERT INTO task_display (task_id, position) VALUES (?, ?)
           ON CONFLICT(task_id) DO UPDATE SET position = excluded.position`,
        ).all(taskId, position);
        recordAudit(db, {
          ts: now,
          project_id: projectId,
          action: "task.move",
          entity_type: "task",
          entity_id: taskId,
          summary: cap(`moved task ${title} → ${first.name}`),
        });
      } else {
        column = col.name;
      }
      db.prepare(
        "UPDATE tasks SET archived_at = NULL, updated_at = ? WHERE id = ?",
      ).all(now, taskId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "task.unarchive",
        entity_type: "task",
        entity_id: taskId,
        summary: cap(`restored task ${title}`),
      });
    })();
  } finally {
    db.close();
  }
  return { title, column, relocated };
}
