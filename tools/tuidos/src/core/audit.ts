import type { Database } from "bun:sqlite";
import { newId } from "./id";

export interface AuditEvent {
  ts: number;
  project_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
}

export interface AuditRow extends AuditEvent {
  id: string;
}

export interface ReadAuditOpts {
  limit?: number;
  projectId?: string;
}

/** Call in the mutation's transaction so the audit trail cannot diverge. */
export function recordAudit(db: Database, ev: AuditEvent): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, project_id, action, entity_type, entity_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).all(
    newId(),
    ev.ts,
    ev.project_id,
    ev.action,
    ev.entity_type,
    ev.entity_id,
    ev.summary,
  );
}

/** Newest first; non-positive limit means unlimited; missing table returns []. */
export function readAuditRows(
  db: Database,
  opts: ReadAuditOpts = {},
): AuditRow[] {
  const limit = opts.limit ?? 0;
  const where = opts.projectId != null ? "WHERE project_id = ?" : "";
  const params: (string | number)[] = [];
  if (opts.projectId != null) params.push(opts.projectId);
  let sql = `SELECT id, ts, project_id, action, entity_type, entity_id, summary FROM audit_log ${where} ORDER BY ts DESC, id DESC`;
  if (limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  try {
    return db.prepare(sql).all(...params) as AuditRow[];
  } catch {
    return [];
  }
}
