import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openProjectRead, openProjectWrite } from "./db";
import { mediaDir, mediaPath } from "./paths";
import { newId } from "./id";
import { recordAudit } from "./audit";

export interface MediaRow {
  id: string;
  message_id: string;
  content_hash: string;
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  created_at: number;
  archived_at: number | null;
}

function cap(s: string): string {
  return s.slice(0, 512);
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const MEDIA_COLS = "id, message_id, content_hash, filename, mime_type, size_bytes, created_at, archived_at";

/** Attach a file as media to a message: hash it, store the blob
 *  content-addressed (dedup), insert a metadata row. Returns the new row. */
export function addMedia(
  projectId: string,
  taskId: string,
  messageId: string,
  sourcePath: string,
  filename?: string | null,
  mimeType?: string | null,
): MediaRow {
  if (!existsSync(sourcePath)) throw new Error(`file not found: ${sourcePath}`);
  const bytes = readFileSync(sourcePath);
  const hash = sha256Hex(bytes);
  mkdirSync(mediaDir(projectId), { recursive: true });
  const blobPath = mediaPath(projectId, hash);
  if (!existsSync(blobPath)) writeFileSync(blobPath, bytes); // dedup: skip if present
  const id = newId();
  const now = Date.now();
  const fname = filename ?? path.basename(sourcePath);
  const mime = mimeType ?? null;
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const msg = db.prepare(
        `SELECT m.id FROM card_messages m WHERE m.id = ? AND m.task_id = ? AND m.archived_at IS NULL`,
      ).get(messageId, taskId) as { id: string } | null;
      if (!msg) throw new Error(`no active message '${messageId}' on task '${taskId}'`);
      db.prepare(
        `INSERT INTO message_media (id, message_id, content_hash, filename, mime_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).all(id, messageId, hash, fname, mime, bytes.length, now);
      recordAudit(db, {
        ts: now, project_id: projectId, action: "media.create", entity_type: "media",
        entity_id: id, summary: cap(`attached ${fname} (${bytes.length}B)`),
      });
    })();
    return {
      id, message_id: messageId, content_hash: hash, filename: fname, mime_type: mime,
      size_bytes: bytes.length, created_at: now, archived_at: null,
    };
  } finally {
    db.close();
  }
}

/** Active media on one message. */
export function listMediaForMessage(projectId: string, messageId: string): MediaRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT ${MEDIA_COLS} FROM message_media WHERE message_id = ? AND archived_at IS NULL ORDER BY created_at`,
    ).all(messageId) as MediaRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** All active media across a task's messages (joined), for `task show`. */
export function listMediaForTask(projectId: string, taskId: string): MediaRow[] {
  const db = openProjectRead(projectId);
  if (!db) return [];
  try {
    return db.prepare(
      `SELECT mm.id, mm.message_id, mm.content_hash, mm.filename, mm.mime_type,
              mm.size_bytes, mm.created_at, mm.archived_at
       FROM message_media mm
       JOIN card_messages m ON m.id = mm.message_id
       WHERE m.task_id = ? AND mm.archived_at IS NULL AND m.archived_at IS NULL
       ORDER BY mm.created_at`,
    ).all(taskId) as MediaRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/** Archive (soft-delete) a media row. The blob stays on disk (GC is deferred). */
export function archiveMedia(projectId: string, taskId: string, mediaId: string): string {
  const now = Date.now();
  let filename = "";
  const db = openProjectWrite(projectId);
  try {
    db.transaction(() => {
      const row = db.prepare(
        `SELECT mm.filename FROM message_media mm
         JOIN card_messages m ON m.id = mm.message_id
         WHERE mm.id = ? AND m.task_id = ? AND mm.archived_at IS NULL`,
      ).get(mediaId, taskId) as { filename: string } | null;
      if (!row) throw new Error(`no active media '${mediaId}' on this task`);
      filename = row.filename;
      db.prepare("UPDATE message_media SET archived_at = ? WHERE id = ?").all(now, mediaId);
      recordAudit(db, {
        ts: now, project_id: projectId, action: "media.archive", entity_type: "media",
        entity_id: mediaId, summary: cap(`removed media ${filename}`),
      });
    })();
  } finally {
    db.close();
  }
  return filename;
}
