import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { GLOBAL_DDL, PROJECT_DDL, DEFAULT_COLUMNS } from "./schema";
import { globalDbPath, projectDir, projectDbPath, tuidosDir } from "./paths";
import { newId } from "./id";
import { recordAudit, readAuditRows, type AuditRow } from "./audit";

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface ProjectRowFull extends ProjectRow {
  archived_at: number | null;
}

const ACTIVE = "archived_at IS NULL";

export function openReadonly(file: string): Database | null {
  if (!existsSync(file)) return null;
  try {
    const db = new Database(file, { readonly: true });
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch {
    return null;
  }
}

export function openReadWrite(file: string): Database {
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return db;
}

/** Count active projects. Returns 0 if the global DB does not exist yet. */
export function countProjects(): number {
  const db = openReadonly(globalDbPath());
  if (!db) return 0;
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM projects WHERE ${ACTIVE}`).get() as
      | { n: number }
      | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

/** List active projects, newest first. limit <= 0 means all. */
export function listProjects(limit = 0): ProjectRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    const sql =
      `SELECT id, name, description, created_at, updated_at FROM projects WHERE ${ACTIVE} ORDER BY updated_at DESC`
      + (limit > 0 ? " LIMIT ?" : "");
    const stmt = db.prepare(sql);
    return (limit > 0 ? stmt.all(limit) : stmt.all()) as ProjectRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** List ALL projects including archived (for audit name resolution + traversal). */
export function listAllProjects(): ProjectRowFull[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT id, name, description, created_at, updated_at, archived_at FROM projects ORDER BY created_at DESC",
    ).all() as ProjectRowFull[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** True if `e` is a SQLite UNIQUE-constraint violation (a duplicate name). Bun
 *  tags these with code SQLITE_CONSTRAINT_UNIQUE; the message also contains
 *  "UNIQUE" as a fallback. */
export function isUniqueViolation(e: unknown): boolean {
  if (e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return true;
  return e instanceof Error && e.message.includes("UNIQUE");
}

/** Create a project: register it globally (audited) and init its per-project DB. */
export function createProject(name: string, description: string | null): ProjectRow {
  const id = newId();
  const now = Date.now();
  const summary =
    (`created project ${name}${description ? ` — ${description}` : ""}`).slice(0, 512);

  mkdirSync(tuidosDir(), { recursive: true });
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    const insertProject = db.prepare(
      "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    // Atomic: the project row and its audit entry commit together or not at all.
    db.transaction(() => {
      insertProject.all(id, name, description, now, now);
      recordAudit(db, {
        ts: now,
        project_id: id,
        action: "project.create",
        entity_type: "project",
        entity_id: id,
        summary,
      });
    })();
  } catch (e) {
    if (isUniqueViolation(e))
      throw new Error(`a project named '${name}' already exists (run \`clidos project list\` to see existing projects)`);
    throw e;
  } finally {
    db.close();
  }

  initProjectDb(id);
  return { id, name, description, created_at: now, updated_at: now };
}

/** Create the per-project state.sqlite with its schema and default columns. Idempotent. */
export function initProjectDb(id: string): void {
  mkdirSync(projectDir(id), { recursive: true });
  const db = openReadWrite(projectDbPath(id));
  try {
    db.exec(PROJECT_DDL);
    const hasColumns =
      (db.prepare("SELECT COUNT(*) AS n FROM columns").get() as { n: number }).n > 0;
    if (hasColumns) return;
    const now = Date.now();
    const insColumn = db.prepare(
      "INSERT INTO columns (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
    );
    const insDisplay = db.prepare(
      "INSERT INTO column_display (column_id, position) VALUES (?, ?)",
    );
    for (const [name, position] of DEFAULT_COLUMNS) {
      const columnId = newId();
      insColumn.all(columnId, name, now, now);
      insDisplay.all(columnId, position);
    }
  } finally {
    db.close();
  }
}

/** Read the global audit log (project/topic lifecycle). projectId filters. */
export function readGlobalAudit(opts: { projectId?: string; limit?: number } = {}): AuditRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return readAuditRows(db, opts);
  } finally {
    db.close();
  }
}

/** Read one project's audit log (task/column changes). */
export function readProjectAudit(projectId: string, opts: { limit?: number } = {}): AuditRow[] {
  const db = openReadonly(projectDbPath(projectId));
  if (!db) return [];
  try {
    return readAuditRows(db, opts);
  } finally {
    db.close();
  }
}
