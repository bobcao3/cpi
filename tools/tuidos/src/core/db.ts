import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { GLOBAL_DDL, PROJECT_DDL } from "./schema";
import { DEFAULT_COLUMNS, DEFAULT_TOPICS } from "./defaults";
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

/** Idempotent; must run before PROJECT_DDL so indexes on migrated columns succeed. */
export function migrateProjectDb(db: Database): void {
  const cols = db.prepare("PRAGMA table_info(columns)").all() as {
    name: string;
  }[];
  if (cols.length > 0 && !cols.some((c) => c.name === "archived_at")) {
    db.exec(
      "ALTER TABLE columns ADD COLUMN archived_at INTEGER" +
        " CHECK (archived_at IS NULL OR archived_at >= updated_at)",
    );
  }
}

function ensureSchema(db: Database): void {
  migrateProjectDb(db);
  db.exec(PROJECT_DDL);
}

/** Migrate through a write handle before reopening read-only; absent DBs return null. */
export function openProjectRead(projectId: string): Database | null {
  const path = projectDbPath(projectId);
  if (!existsSync(path)) return null;
  const w = openReadWrite(path);
  try {
    ensureSchema(w);
  } finally {
    w.close();
  }
  return openReadonly(path);
}

export function openProjectWrite(projectId: string): Database {
  const db = openReadWrite(projectDbPath(projectId));
  ensureSchema(db);
  return db;
}

export function countProjects(): number {
  const db = openReadonly(globalDbPath());
  if (!db) return 0;
  try {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM projects WHERE ${ACTIVE}`)
      .get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

export function listProjects(limit = 0): ProjectRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    const sql =
      `SELECT id, name, description, created_at, updated_at FROM projects WHERE ${ACTIVE} ORDER BY updated_at DESC` +
      (limit > 0 ? " LIMIT ?" : "");
    const stmt = db.prepare(sql);
    return (limit > 0 ? stmt.all(limit) : stmt.all()) as ProjectRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Includes archived projects for audit resolution and traversal. */
export function listAllProjects(): ProjectRowFull[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return db
      .prepare(
        "SELECT id, name, description, created_at, updated_at, archived_at FROM projects ORDER BY created_at DESC",
      )
      .all() as ProjectRowFull[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Accept Bun's error code and SQLite's message as fallbacks. */
export function isUniqueViolation(e: unknown): boolean {
  if (
    e instanceof Error &&
    (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
  )
    return true;
  return e instanceof Error && e.message.includes("UNIQUE");
}

export function createProject(
  name: string,
  description: string | null,
  options: { applyDefaults?: boolean } = {},
): ProjectRow {
  const id = newId();
  const now = Date.now();
  const summary =
    `created project ${name}${description ? ` — ${description}` : ""}`.slice(
      0,
      512,
    );

  mkdirSync(tuidosDir(), { recursive: true });
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    const insertProject = db.prepare(
      "INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    );
    // Keep the project row and audit entry atomic.
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
      throw new Error(
        `a project named '${name}' already exists (run \`clidos project list\` to see existing projects)`,
      );
    throw e;
  } finally {
    db.close();
  }

  initProjectDb(id);
  if (options.applyDefaults ?? true) applyProjectDefaults(id);
  return { id, name, description, created_at: now, updated_at: now };
}

export function initProjectDb(id: string): void {
  mkdirSync(projectDir(id), { recursive: true });
  const db = openProjectWrite(id);
  db.close();
}

export function applyProjectDefaults(projectId: string): {
  columns: number;
  topics: number;
} {
  let columns = 0;
  let topics = 0;
  const now = Date.now();

  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const has = db.prepare("SELECT 1 FROM columns WHERE name = ?");
      const ins = db.prepare(
        "INSERT INTO columns (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      const insDisp = db.prepare(
        "INSERT INTO column_display (column_id, position) VALUES (?, ?)",
      );
      for (const [name, position] of DEFAULT_COLUMNS) {
        if (has.get(name)) continue;
        const columnId = newId();
        ins.all(columnId, name, now, now);
        insDisp.all(columnId, position);
        columns++;
      }
    })();
  } finally {
    db.close();
  }

  const gdb = openReadWrite(globalDbPath());
  try {
    gdb.exec(GLOBAL_DDL);
    gdb.transaction(() => {
      const has = gdb.prepare(
        "SELECT 1 FROM topics WHERE project_id = ? AND name = ?",
      );
      const ins = gdb.prepare(
        "INSERT INTO topics (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      for (const name of DEFAULT_TOPICS) {
        if (has.get(projectId, name)) continue;
        const topicId = newId();
        ins.all(topicId, projectId, name, now, now);
        topics++;
      }
    })();
  } finally {
    gdb.close();
  }

  return { columns, topics };
}

export function readGlobalAudit(
  opts: { projectId?: string; limit?: number } = {},
): AuditRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return readAuditRows(db, opts);
  } finally {
    db.close();
  }
}

export function readProjectAudit(
  projectId: string,
  opts: { limit?: number } = {},
): AuditRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return readAuditRows(db, opts);
  } finally {
    db.close();
  }
}
