import { listAllProjects, readGlobalAudit, readProjectAudit } from "../core/db";
import type { AuditRow } from "../core/audit";
import { matchIdPrefix } from "../core/id";
import pc from "picocolors";

export const READ_CAP = 1000;

export type EnrichedAuditRow = AuditRow & { projectName: string | null };

export function fail(message: string): never {
  const tag = pc.isColorSupported ? pc.red("error:") : "**error:**";
  console.error(`${tag} ${message}`);
  process.exit(1);
}

export function warn(message: string, remedy?: string): void {
  const tag = pc.isColorSupported ? pc.yellow("warning:") : "**warning:**";
  console.error(`${tag} ${message}`);
  if (remedy) console.error(pc.isColorSupported ? pc.dim(remedy) : remedy);
}

export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

export function parseLimit(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) fail(`invalid --limit: ${s ?? ""}`);
  return n;
}

function cmpIdDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function enrich(
  rows: AuditRow[],
  byId: Map<string, { name: string }>,
): EnrichedAuditRow[] {
  return rows.map((r) => ({
    ...r,
    projectName: r.project_id ? (byId.get(r.project_id)?.name ?? null) : null,
  }));
}

export function collectAudit(
  limit: number,
  projectId: string | null,
): EnrichedAuditRow[] {
  const projects = listAllProjects();
  const byId = new Map(projects.map((p) => [p.id, { name: p.name }]));

  const rows: EnrichedAuditRow[] = [];
  rows.push(
    ...enrich(
      readGlobalAudit({ projectId: projectId ?? undefined, limit: READ_CAP }),
      byId,
    ),
  );

  const targets = projectId ? projects.filter((p) => p.id === projectId) : [];
  for (const p of targets) {
    rows.push(...enrich(readProjectAudit(p.id, { limit: READ_CAP }), byId));
  }

  rows.sort((a, b) => b.ts - a.ts || cmpIdDesc(a.id, b.id));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

export function resolveProjectId(arg: string): string {
  if (!arg) fail("project id or name is required");
  const projects = listAllProjects();
  if (projects.length === 0) fail("no projects exist yet");
  const ids = projects.map((p) => p.id);
  if (ids.includes(arg)) return arg;
  const exact = projects.find((p) => p.name === arg);
  if (exact) return exact.id;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1)
    fail(
      `ambiguous id prefix '${arg}' — matches ${pm.length} projects (use more characters)`,
    );
  const pmMatch = pm[0];
  if (pmMatch) return pmMatch;
  const lower = arg.toLowerCase();
  const ci = projects.filter((p) => p.name.toLowerCase() === lower);
  if (ci.length > 1) fail(`ambiguous project name '${arg}'`);
  const ciMatch = ci[0];
  if (ciMatch) return ciMatch.id;
  fail(`no project '${arg}' (run \`clidos project list\` for projects)`);
}
