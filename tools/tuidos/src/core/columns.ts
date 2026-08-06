import type { Database } from "bun:sqlite";
import { openProjectRead, openProjectWrite, isUniqueViolation } from "./db";
import { newId } from "./id";
import { recordAudit } from "./audit";

export interface ColumnRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function cap(s: string): string {
  return s.slice(0, 512);
}

/** List a project's active columns in board order (position, then created_at). */
export function listColumns(projectId: string): ColumnRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return db
      .prepare(
        `SELECT c.id, c.name, c.created_at, c.updated_at, c.archived_at FROM columns c
       LEFT JOIN column_display d ON d.column_id = c.id
       WHERE c.archived_at IS NULL
       ORDER BY COALESCE(d.position, 0), c.created_at`,
      )
      .all() as ColumnRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Active task count per column id, for the column list view. */
export function countTasksByColumn(projectId: string): Map<string, number> {
  const counts = new Map<string, number>();
  const db = openProjectRead(projectId);
  if (!db) return counts;
  try {
    const rows = db
      .prepare(
        `SELECT column_id AS id, COUNT(*) AS n FROM tasks
       WHERE archived_at IS NULL GROUP BY column_id`,
      )
      .all() as { id: string; n: number }[];
    for (const r of rows) counts.set(r.id, r.n);
  } catch {
    // fall through with whatever was collected
  } finally {
    db.close();
  }
  return counts;
}

/** Next column position (max + 1, or 0). */
function nextColumnPosition(db: Database): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM column_display")
    .get() as { p: number };
  return row.p;
}

/** Create a column (appended to the end of the board). */
export function createColumn(projectId: string, name: string): ColumnRow {
  if (!name) throw new Error("column name is required");
  const id = newId();
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const position = nextColumnPosition(db);
      db.prepare(
        "INSERT INTO columns (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ).all(id, name, now, now);
      db.prepare(
        "INSERT INTO column_display (column_id, position) VALUES (?, ?)",
      ).all(id, position);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "column.create",
        entity_type: "column",
        entity_id: id,
        summary: cap(`created column ${name}`),
      });
    })();
    return { id, name, created_at: now, updated_at: now, archived_at: null };
  } catch (e) {
    if (isUniqueViolation(e))
      throw new Error(
        `a column named '${name}' already exists — use a different name, or rename it (clidos -p <project> columns rename <name> <new>)`,
      );
    throw e;
  } finally {
    db.close();
  }
}

/** Rename a column (name is unique; tasks keep pointing to its id). Returns old name. */
export function renameColumn(
  projectId: string,
  columnId: string,
  newName: string,
): string {
  if (!newName) throw new Error("new column name is required");
  const now = Date.now();
  let oldName = "";
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(
          `SELECT name FROM columns WHERE id = ? AND archived_at IS NULL`,
        )
        .get(columnId) as { name: string } | null;
      if (!row) throw new Error(`no active column '${columnId}'`);
      oldName = row.name;
      db.prepare(
        "UPDATE columns SET name = ?, updated_at = ? WHERE id = ?",
      ).all(newName, now, columnId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "column.rename",
        entity_type: "column",
        entity_id: columnId,
        summary: cap(`renamed column ${oldName} → ${newName}`),
      });
    })();
  } catch (e) {
    if (isUniqueViolation(e))
      throw new Error(
        `a column named '${newName}' already exists — use a different name`,
      );
    throw e;
  } finally {
    db.close();
  }
  return oldName;
}

/** Reorder a column to a 0-based position; re-densifies all positions. */
export function moveColumn(
  projectId: string,
  columnId: string,
  newPosition: number,
): void {
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const cols = db
        .prepare(
          `SELECT c.id, c.name FROM columns c LEFT JOIN column_display d ON d.column_id = c.id
         WHERE c.archived_at IS NULL ORDER BY COALESCE(d.position, 0), c.created_at`,
        )
        .all() as { id: string; name: string }[];
      const idx = cols.findIndex((c) => c.id === columnId);
      if (idx < 0) throw new Error(`no active column '${columnId}'`);
      if (
        !Number.isInteger(newPosition) ||
        newPosition < 0 ||
        newPosition >= cols.length
      )
        throw new Error(
          `position must be 0..${cols.length - 1} (got ${newPosition})`,
        );
      const [moved] = cols.splice(idx, 1);
      cols.splice(newPosition, 0, moved!);
      const upsert = db.prepare(
        `INSERT INTO column_display (column_id, position) VALUES (?, ?)
         ON CONFLICT(column_id) DO UPDATE SET position = excluded.position`,
      );
      cols.forEach((c, i) => upsert.all(c.id, i));
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "column.move",
        entity_type: "column",
        entity_id: columnId,
        summary: cap(
          `reordered column ${moved!.name} to position ${newPosition}`,
        ),
      });
    })();
  } finally {
    db.close();
  }
}

/** Archive a column (tombstone). Refuses while active tasks are still in it. */
export function archiveColumn(projectId: string, columnId: string): string {
  const now = Date.now();
  let name = "";
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db
        .prepare(`SELECT name, archived_at FROM columns WHERE id = ?`)
        .get(columnId) as { name: string; archived_at: number | null } | null;
      if (!row) throw new Error(`no column '${columnId}'`);
      if (row.archived_at != null)
        throw new Error(`column '${row.name}' is already archived`);
      name = row.name;
      const { n } = db
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE column_id = ? AND archived_at IS NULL`,
        )
        .get(columnId) as { n: number };
      if (n > 0)
        throw new Error(
          `column '${name}' still has ${n} active task(s) — move them first: clidos -p <project> task move <task> <other-column>`,
        );
      db.prepare(
        "UPDATE columns SET archived_at = ?, updated_at = ? WHERE id = ?",
      ).all(now, now, columnId);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "column.archive",
        entity_type: "column",
        entity_id: columnId,
        summary: cap(`archived column ${name}`),
      });
    })();
  } finally {
    db.close();
  }
  return name;
}
