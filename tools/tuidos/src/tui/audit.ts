import { listAllProjects, readGlobalAudit, readProjectAudit } from "../core/db";
import type { AuditRow } from "../core/audit";

export interface AuditLine extends AuditRow {
  projectName: string | null;
}

// Both logs are merged newest-first; the UTC Unix millisecond timestamp invariant is load-bearing.
const READ_CAP = 1000;

export function collectProjectAudit(
  projectId: string,
  limit = 200,
): AuditLine[] {
  const byId = new Map(listAllProjects().map((p) => [p.id, p.name]));
  const rows: AuditLine[] = [
    ...readGlobalAudit({ projectId, limit: READ_CAP }),
    ...readProjectAudit(projectId, { limit: READ_CAP }),
  ].map((r) => ({
    ...r,
    projectName: r.project_id ? (byId.get(r.project_id) ?? null) : null,
  }));
  rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return limit > 0 ? rows.slice(0, limit) : rows;
}
