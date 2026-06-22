import { listAllProjects, readGlobalAudit, readProjectAudit } from "../core/db";
import type { AuditRow } from "../core/audit";
import { matchIdPrefix } from "../core/id";
import pc from "picocolors";

/** Per-source read cap: a defensive bound so a long-lived install never reads
 *  unbounded rows per source before the global sort+limit (TigerStyle). */
export const READ_CAP = 1000;

/** An audit row annotated with the owning project's name, for display. */
export type EnrichedAuditRow = AuditRow & { projectName: string | null };

/** Print a clean user-facing error to stderr and exit non-zero. citty does not
 *  export its CLIError, so custom input errors are handled here rather than
 *  thrown (a thrown Error would dump a stack trace via runMain). */
export function fail(message: string): never {
  const tag = pc.isColorSupported ? pc.red("error:") : "**error:**";
  console.error(`${tag} ${message}`);
  process.exit(1);
}

/** Run a core operation; on a thrown error, render it cleanly via fail(). Core
 *  is shared with the TUI, so it throws rather than process.exit-ing. */
export function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/** Parse a --limit string into a non-negative int (0 = all). */
export function parseLimit(s: string | undefined): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n < 0) fail(`invalid --limit: ${s ?? ""}`);
  return n;
}

function cmpIdDesc(a: string, b: string): number {
  return a < b ? 1 : a > b ? -1 : 0;
}

function enrich(rows: AuditRow[], byId: Map<string, { name: string }>): EnrichedAuditRow[] {
  return rows.map((r) => ({
    ...r,
    projectName: r.project_id ? byId.get(r.project_id)?.name ?? null : null,
  }));
}

/**
 * Collect a merged, newest-first audit timeline.
 * - `projectId === null` (the `clidos audit` global view): the GLOBAL DB's audit
 *   log only — project/topic lifecycle across all projects. Per-project
 *   task/column events are NOT included; use `clidos project audit <id-or-name>`.
 * - a specific id (`clidos project audit <p>`): that project's full activity —
 *   its global lifecycle events plus its own per-project log.
 */
export function collectAudit(limit: number, projectId: string | null): EnrichedAuditRow[] {
  const projects = listAllProjects();
  const byId = new Map(projects.map((p) => [p.id, { name: p.name }]));

  const rows: EnrichedAuditRow[] = [];
  rows.push(...enrich(readGlobalAudit({ projectId: projectId ?? undefined, limit: READ_CAP }), byId));

  // Global view audits the global DB only; a project view also pulls that
  // project's per-project log.
  const targets = projectId ? projects.filter((p) => p.id === projectId) : [];
  for (const p of targets) {
    rows.push(...enrich(readProjectAudit(p.id, { limit: READ_CAP }), byId));
  }

  rows.sort((a, b) => b.ts - a.ts || cmpIdDesc(a.id, b.id));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

/** Resolve a project reference to its id: exact id, exact name, an
 *  unambiguous id prefix (git-style), or a case-insensitive name. Names are
 *  unique (UNIQUE); prefixes are re-checked for ambiguity at resolve time.
 *  Core never keys by name. */
export function resolveProjectId(arg: string): string {
  if (!arg) fail("project id or name is required");
  const projects = listAllProjects();
  if (projects.length === 0) fail("no projects exist yet");
  const ids = projects.map((p) => p.id);
  if (ids.includes(arg)) return arg;
  const exact = projects.find((p) => p.name === arg);
  if (exact) return exact.id;
  const pm = matchIdPrefix(arg, ids);
  if (pm.length > 1) fail(`ambiguous id prefix '${arg}' — matches ${pm.length} projects (use more characters)`);
  const pmMatch = pm[0];
  if (pmMatch) return pmMatch;
  const lower = arg.toLowerCase();
  const ci = projects.filter((p) => p.name.toLowerCase() === lower);
  if (ci.length > 1) fail(`ambiguous project name '${arg}'`);
  const ciMatch = ci[0];
  if (ciMatch) return ciMatch.id;
  fail(`no project '${arg}' (run \`clidos project list\` for projects)`);
}
