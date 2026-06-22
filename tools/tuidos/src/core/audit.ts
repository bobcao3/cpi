import type { Database } from "bun:sqlite";
import { newId } from "./id";

/** A state-change event to record. Field names mirror the audit_log columns. */
export interface AuditEvent {
  ts: number;
  project_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
}

/** A recorded audit row (an AuditEvent plus its ULID primary key). */
export interface AuditRow extends AuditEvent {
  id: string;
}

export interface ReadAuditOpts {
  limit?: number;
  projectId?: string;
}

/**
 * Append one audit row. Call inside the same transaction as the mutation it
 * describes, so the trail never diverges from the data. The id is a fresh ULID
 * random id; ordering is by `ts`, not id.
 */
export function recordAudit(db: Database, ev: AuditEvent): void {
  db.prepare(
    `INSERT INTO audit_log (id, ts, project_id, action, entity_type, entity_id, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).all(newId(), ev.ts, ev.project_id, ev.action, ev.entity_type, ev.entity_id, ev.summary);
}

/**
 * Read audit rows newest-first. `projectId` filters by project_id; `limit<=0`
 * means all (callers cap per source). A missing audit_log table (pre-audit DB)
 * yields [] rather than throwing.
 */
export function readAuditRows(db: Database, opts: ReadAuditOpts = {}): AuditRow[] {
  const limit = opts.limit ?? 0;
  const where = opts.projectId != null ? "WHERE project_id = ?" : "";
  const params: (string | number)[] = [];
  if (opts.projectId != null) params.push(opts.projectId);
  let sql =
    `SELECT id, ts, project_id, action, entity_type, entity_id, summary FROM audit_log ${where} ORDER BY ts DESC, id DESC`;
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
