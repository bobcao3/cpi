import { openReadonly, openReadWrite, isUniqueViolation } from "./db";
import { globalDbPath } from "./paths";
import { newId } from "./id";
import { recordAudit } from "./audit";
import { GLOBAL_DDL } from "./schema";

export interface TopicRow {
  id: string;
  project_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

/** Cap an audit summary to the audit_log.summary CHECK (<=512). */
function cap(s: string): string {
  return s.slice(0, 512);
}

/** List a project's active topics, alphabetical. */
export function listTopics(projectId: string): TopicRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT id, project_id, name, created_at, updated_at FROM topics WHERE project_id = ? AND archived_at IS NULL ORDER BY name",
    ).all(projectId) as TopicRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Create a topic in a project. `name` is the label to assign (not a key).
 *  Throws on duplicate name (the UNIQUE(project_id, name) constraint). */
export function createTopic(projectId: string, name: string): TopicRow {
  const id = newId();
  const now = Date.now();
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    try {
      db.transaction(() => {
        db.prepare(
          "INSERT INTO topics (id, project_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).all(id, projectId, name, now, now);
        recordAudit(db, {
          ts: now,
          project_id: projectId,
          action: "topic.create",
          entity_type: "topic",
          entity_id: id,
          summary: cap(`created topic ${name}`),
        });
      })();
    } catch (e) {
      if (isUniqueViolation(e)) throw new Error(`topic '${name}' already exists in this project — use a different name`);
      throw e;
    }
  } finally {
    db.close();
  }
  return { id, project_id: projectId, name, created_at: now, updated_at: now };
}

/** Rename a topic by its ULID. Returns the old name. Throws if not found or the
 *  new name is taken (UNIQUE). Names are labels, never lookup keys. */
export function renameTopic(projectId: string, topicId: string, newName: string): string {
  const now = Date.now();
  let oldName = "";
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    db.transaction(() => {
      const row = db.prepare(
        "SELECT id, name FROM topics WHERE project_id = ? AND archived_at IS NULL AND id = ?",
      ).get(projectId, topicId) as { id: string; name: string } | null;
      if (!row) throw new Error(`no topic '${topicId}' in this project`);
      oldName = row.name;
      db.prepare("UPDATE topics SET name = ?, updated_at = ? WHERE id = ?").all(newName, now, row.id);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "topic.rename",
        entity_type: "topic",
        entity_id: row.id,
        summary: cap(`renamed topic ${oldName} → ${newName}`),
      });
    })();
  } catch (e) {
    if (isUniqueViolation(e)) throw new Error(`topic '${newName}' already exists in this project — use a different name`);
    throw e;
  } finally {
    db.close();
  }
  return oldName;
}

/** Archive a topic by its ULID. Returns the topic name. Throws if not found or
 *  already archived. */
export function archiveTopic(projectId: string, topicId: string): string {
  const now = Date.now();
  let name = "";
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    db.transaction(() => {
      const row = db.prepare(
        "SELECT id, name, archived_at FROM topics WHERE project_id = ? AND id = ?",
      ).get(projectId, topicId) as
        | { id: string; name: string; archived_at: number | null }
        | null;
      if (!row) throw new Error(`no topic '${topicId}' in this project`);
      if (row.archived_at != null) throw new Error(`topic '${row.name}' is already archived`);
      name = row.name;
      db.prepare("UPDATE topics SET archived_at = ?, updated_at = ? WHERE id = ?").all(now, now, row.id);
      recordAudit(db, {
        ts: now,
        project_id: projectId,
        action: "topic.archive",
        entity_type: "topic",
        entity_id: row.id,
        summary: cap(`archived topic ${name}`),
      });
    })();
  } finally {
    db.close();
  }
  return name;
}

/** List ALL of a project's topics (active + archived), for name→id resolution
 *  at the CLI boundary. Core itself never looks up by name. */
export function listAllTopics(projectId: string): TopicRow[] {
  const db = openReadonly(globalDbPath());
  if (!db) return [];
  try {
    return db.prepare(
      "SELECT id, project_id, name, created_at, updated_at FROM topics WHERE project_id = ? ORDER BY name",
    ).all(projectId) as TopicRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
