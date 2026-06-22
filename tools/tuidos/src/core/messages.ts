import { openProjectRead, openProjectWrite } from "./db";
import { newId } from "./id";
import { recordAudit } from "./audit";

export interface MessageRow {
  id: string;
  task_id: string;
  author: string | null;
  content: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

function cap(s: string): string {
  return s.slice(0, 512);
}

const MSG_COLS = "id, task_id, author, content, created_at, updated_at, archived_at";

/** A task's active thread (body first), ordered by (created_at, id). */
export function listMessages(projectId: string, taskId: string): MessageRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT ${MSG_COLS} FROM card_messages
       WHERE task_id = ? AND archived_at IS NULL ORDER BY created_at, id`,
    ).all(taskId) as MessageRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** All message ids on a task (active + archived), for id-prefix resolution. */
export function listAllMessageIds(projectId: string, taskId: string): string[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return (db.prepare("SELECT id FROM card_messages WHERE task_id = ?").all(taskId) as { id: string }[]).map((r) => r.id);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Append a message to a task's thread. The first message is the body. */
export function createMessage(
  projectId: string,
  taskId: string,
  author: string | null,
  content: string,
): MessageRow {
  if (!content) throw new Error("content is required");
  const id = newId();
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const task = db.prepare(`SELECT title FROM tasks WHERE id = ? AND archived_at IS NULL`).get(taskId) as
        | { title: string } | null;
      if (!task) throw new Error(`no active task '${taskId}'`);
      db.prepare(
        `INSERT INTO card_messages (id, task_id, author, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).all(id, taskId, author, content, now, now);
      recordAudit(db, {
        ts: now, project_id: projectId, action: "message.create", entity_type: "message",
        entity_id: id, summary: cap(`added message to ${task.title}`),
      });
    })();
    return { id, task_id: taskId, author, content, created_at: now, updated_at: now, archived_at: null };
  } finally {
    db.close();
  }
}

/** Edit a message's content (moves updated_at; ordering stays stable). */
export function updateMessage(
  projectId: string,
  taskId: string,
  messageId: string,
  content: string,
): void {
  if (!content) throw new Error("content is required");
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db.prepare(
        `SELECT m.id FROM card_messages m WHERE m.id = ? AND m.task_id = ? AND m.archived_at IS NULL`,
      ).get(messageId, taskId) as { id: string } | null;
      if (!row) throw new Error(`no active message '${messageId}' on this task`);
      db.prepare("UPDATE card_messages SET content = ?, updated_at = ? WHERE id = ?").all(content, now, messageId);
      recordAudit(db, {
        ts: now, project_id: projectId, action: "message.update", entity_type: "message",
        entity_id: messageId, summary: cap("edited a message"),
      });
    })();
  } finally {
    db.close();
  }
}

/** Archive (soft-delete) a message. The blob stays; the thread keeps its shape. */
export function archiveMessage(projectId: string, taskId: string, messageId: string): void {
  const now = Date.now();
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db.prepare(
        `SELECT m.id FROM card_messages m WHERE m.id = ? AND m.task_id = ? AND m.archived_at IS NULL`,
      ).get(messageId, taskId) as { id: string } | null;
      if (!row) throw new Error(`no active message '${messageId}' on this task`);
      db.prepare("UPDATE card_messages SET archived_at = ?, updated_at = ? WHERE id = ?").all(now, now, messageId);
      recordAudit(db, {
        ts: now, project_id: projectId, action: "message.archive", entity_type: "message",
        entity_id: messageId, summary: cap("archived a message"),
      });
    })();
  } finally {
    db.close();
  }
}
