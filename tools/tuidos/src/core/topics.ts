import {
  openReadonly,
  openReadWrite,
  openProjectRead,
  openProjectWrite,
  isUniqueViolation,
} from "./db";
import { globalDbPath } from "./paths";
import { newId, shortId } from "./id";
import { recordAudit } from "./audit";
import { GLOBAL_DDL } from "./schema";

export interface TopicRow {
  id: string;
  project_id: string;
  name: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
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
    return db
      .prepare(
        "SELECT id, project_id, name, created_at, updated_at, archived_at FROM topics WHERE project_id = ? AND archived_at IS NULL ORDER BY name",
      )
      .all(projectId) as TopicRow[];
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
      if (isUniqueViolation(e))
        throw new Error(
          `topic '${name}' already exists in this project — use a different name`,
        );
      throw e;
    }
  } finally {
    db.close();
  }
  return {
    id,
    project_id: projectId,
    name,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
}

/** Rename a topic by its ULID. Returns the old name. Throws if not found or the
 *  new name is taken (UNIQUE). Names are labels, never lookup keys. */
export function renameTopic(
  projectId: string,
  topicId: string,
  newName: string,
): string {
  const now = Date.now();
  let oldName = "";
  const db = openReadWrite(globalDbPath());
  try {
    db.exec(GLOBAL_DDL);
    db.transaction(() => {
      const row = db
        .prepare(
          "SELECT id, name FROM topics WHERE project_id = ? AND archived_at IS NULL AND id = ?",
        )
        .get(projectId, topicId) as { id: string; name: string } | null;
      if (!row) throw new Error(`no topic '${topicId}' in this project`);
      oldName = row.name;
      db.prepare("UPDATE topics SET name = ?, updated_at = ? WHERE id = ?").all(
        newName,
        now,
        row.id,
      );
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
    if (isUniqueViolation(e))
      throw new Error(
        `topic '${newName}' already exists in this project — use a different name`,
      );
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
      const row = db
        .prepare(
          "SELECT id, name, archived_at FROM topics WHERE project_id = ? AND id = ?",
        )
        .get(projectId, topicId) as {
        id: string;
        name: string;
        archived_at: number | null;
      } | null;
      if (!row) throw new Error(`no topic '${topicId}' in this project`);
      if (row.archived_at != null)
        throw new Error(`topic '${row.name}' is already archived`);
      name = row.name;
      db.prepare(
        "UPDATE topics SET archived_at = ?, updated_at = ? WHERE id = ?",
      ).all(now, now, row.id);
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
    return db
      .prepare(
        "SELECT id, project_id, name, created_at, updated_at, archived_at FROM topics WHERE project_id = ? ORDER BY name",
      )
      .all(projectId) as TopicRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Validate that `topicId` is an active topic in `projectId` (global DB) and
 *  return its name. The tag lives in the project DB but the topic in global
 *  (cross-DB: no FK on task_topics.topic_id), so existence/active-state is
 *  enforced here. Throws with a remedy if missing or archived. */
function requireActiveTopic(projectId: string, topicId: string): string {
  const all = listAllTopics(projectId);
  const t = all.find((x) => x.id === topicId);
  if (!t)
    throw new Error(
      `no topic '${shortId(
        topicId,
        all.map((x) => x.id),
      )}' in this project`,
    );
  if (t.archived_at != null)
    throw new Error(
      `topic '${t.name}' is archived — archived topics can't be tagged`,
    );
  return t.name;
}

/** Attach a topic to a task (idempotent: re-attaching is a no-op with no audit
 *  event). The tag (task_topics) lives in the project DB; the topic lives in
 *  global. Throws if the task or topic is missing, or the topic is archived. */
export function attachTopic(
  projectId: string,
  taskId: string,
  topicId: string,
): { attached: boolean; name: string } {
  const name = requireActiveTopic(projectId, topicId);
  const now = Date.now();
  let attached = false;
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const task = db
        .prepare("SELECT id FROM tasks WHERE id = ? AND archived_at IS NULL")
        .get(taskId) as { id: string } | null;
      if (!task) throw new Error(`no active task '${taskId}'`);
      const res = db
        .prepare(
          "INSERT OR IGNORE INTO task_topics (task_id, topic_id, created_at) VALUES (?, ?, ?)",
        )
        .run(taskId, topicId, now);
      attached = res.changes > 0;
      if (attached) {
        recordAudit(db, {
          ts: now,
          project_id: projectId,
          action: "task.topic.add",
          entity_type: "task",
          entity_id: taskId,
          summary: cap(`tagged task with ${name}`),
        });
      }
    })();
  } finally {
    db.close();
  }
  return { attached, name };
}

/** Detach a topic from a task (idempotent: removing an unattached topic is a
 *  no-op). Throws if the task is missing. Returns the topic name. */
export function detachTopic(
  projectId: string,
  taskId: string,
  topicId: string,
): { detached: boolean; name: string } {
  const all = listAllTopics(projectId);
  const t = all.find((x) => x.id === topicId);
  const name =
    t?.name ??
    shortId(
      topicId,
      all.map((x) => x.id),
    );
  const now = Date.now();
  let detached = false;
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const task = db
        .prepare("SELECT id FROM tasks WHERE id = ? AND archived_at IS NULL")
        .get(taskId) as { id: string } | null;
      if (!task) throw new Error(`no active task '${taskId}'`);
      const res = db
        .prepare("DELETE FROM task_topics WHERE task_id = ? AND topic_id = ?")
        .run(taskId, topicId);
      detached = res.changes > 0;
      if (detached) {
        recordAudit(db, {
          ts: now,
          project_id: projectId,
          action: "task.topic.remove",
          entity_type: "task",
          entity_id: taskId,
          summary: cap(`untagged task from ${name}`),
        });
      }
    })();
  } finally {
    db.close();
  }
  return { detached, name };
}

/** A task's active topics, alphabetical by name. Tags (task_topics) live in the
 *  project DB, names in global — joined by id across the two databases. */
export function listTopicsForTask(
  projectId: string,
  taskId: string,
): TopicRow[] {
  const pdb = openProjectRead(projectId);
  if (!pdb) return [];
  let ids: string[] = [];
  try {
    ids = (
      pdb
        .prepare("SELECT topic_id FROM task_topics WHERE task_id = ?")
        .all(taskId) as { topic_id: string }[]
    ).map((r) => r.topic_id);
  } catch {
    return [];
  } finally {
    pdb.close();
  }
  if (ids.length === 0) return [];
  return listAllTopics(projectId).filter(
    (t) => ids.includes(t.id) && t.archived_at == null,
  );
}
