import { listAllProjects, readGlobalAudit, readProjectAudit } from "../core/db";
import type { AuditRow } from "../core/audit";

// An audit row annotated with the owning project's name, for display.
export interface AuditLine extends AuditRow {
  projectName: string | null;
}

// Collect one project's full activity — its global lifecycle events plus its
// own per-project log — merged newest-first. Mirrors clidos/audit-view's
// collectAudit(projectId) but reads core directly (no clidos import: that
// would pull the CLI's process.exit paths). The cross-file merge is why the
// UTC-unix-ms timestamp invariant is load-bearing (DESIGN.md rule 1).
const READ_CAP = 1000;

export function collectProjectAudit(projectId: string, limit = 200): AuditLine[] {
  const byId = new Map(listAllProjects().map((p) => [p.id, p.name]));
  const rows: AuditLine[] = [
    ...readGlobalAudit({ projectId, limit: READ_CAP }),
    ...readProjectAudit(projectId, { limit: READ_CAP }),
  ].map((r) => ({ ...r, projectName: r.project_id ? (byId.get(r.project_id) ?? null) : null }));
  rows.sort((a, b) => b.ts - a.ts || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return limit > 0 ? rows.slice(0, limit) : rows;
}
