import { listAllProjects, readGlobalAudit, readProjectAudit } from "../core/db";

export function relativeTime(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - milliseconds) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function dueDate(milliseconds: number | null): string {
  return milliseconds == null
    ? ""
    : new Date(milliseconds).toISOString().slice(0, 10);
}

export function priorityLabel(priority: number | null): string {
  return ["", "Low", "Medium", "High", "Urgent"][priority ?? 0] ?? "";
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function collectProjectAudit(projectId: string, limit = 200) {
  const names = new Map(
    listAllProjects(1001).map((project) => [project.id, project.name]),
  );
  const rows = [
    ...readGlobalAudit({ projectId, limit: 1000 }),
    ...readProjectAudit(projectId, { limit: 1000 }),
  ].map((row) => ({
    ...row,
    projectName: row.project_id ? (names.get(row.project_id) ?? null) : null,
  }));
  rows.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
  return rows.slice(0, Math.max(0, Math.min(limit, 200)));
}
