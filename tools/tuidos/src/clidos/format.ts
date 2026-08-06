import pc from "picocolors";
import { renderUsage, type CommandDef } from "citty";
import type { ProjectRow } from "../core/db";
import type { TopicRow } from "../core/topics";
import type { AuditRow } from "../core/audit";
import { uid } from "./uid";

// picocolors is the source of truth for whether ANSI color is emitted.
const color: boolean = pc.isColorSupported;

export const accent = (s: string) => (color ? pc.cyan(s) : `*${s}*`);
export const muted = (s: string) => (color ? pc.dim(s) : s);
export const bold = (s: string) => (color ? pc.bold(s) : `**${s}**`);
export const heading = (s: string) =>
  color ? pc.bold(pc.underline(s)) : `# ${s}`;
export const note = (s: string) => (color ? pc.dim(s) : `> ${s}`);
export const ok = (s: string) => (color ? pc.green(s) : s);

/** Pad `s` to `width` columns after `accent`; the non-TTY *…* markup adds a
 *  constant 2 chars to every cell, so columns stay aligned. */
export function padAccent(s: string, width: number): string {
  return accent(s) + " ".repeat(Math.max(0, width - s.length));
}

/** Strip ANSI/CSI escape sequences so piped usage output is clean text. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** Lives here to avoid a circular import of `main` into the command modules. */
export const ROOT_PARENT: CommandDef<any> = {
  meta: { name: "clidos", version: "0.1.0" },
};

export async function renderUsageClean(
  cmd: CommandDef<any>,
  parent?: CommandDef<any>,
): Promise<string> {
  const out = await renderUsage(cmd, parent);
  return color ? out : stripAnsi(out);
}

/** Short `-h` help: return only the USAGE line, no description/COMMANDS/etc. */
export async function renderUsageShort(
  cmd: CommandDef<any>,
  parent?: CommandDef<any>,
): Promise<string> {
  const out = await renderUsage(cmd, parent);
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => stripAnsi(l).startsWith("USAGE "));
  return idx >= 0 ? (lines[idx] ?? out) : out;
}

export function relativeTime(ms: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ms) / 1000));
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

export function renderProjectList(projects: ProjectRow[]): string {
  if (projects.length === 0) return muted("  (no projects)");
  const width = Math.max(8, ...projects.map((p) => p.name.length));
  return projects
    .map((p) => {
      const line = `  ${padAccent(p.name, width)}  ${uid(
        p.id,
        projects.map((x) => x.id),
      )}  ${muted(relativeTime(p.updated_at))}`;
      return p.description ? `${line}  ${p.description}` : line;
    })
    .join("\n");
}

export function renderProjectBullets(projects: ProjectRow[]): string {
  if (projects.length === 0) return muted("(no projects)");
  return projects
    .map(
      (p) =>
        `${muted("--")} ${accent(p.name)} ${uid(
          p.id,
          projects.map((x) => x.id),
        )} ${muted(relativeTime(p.updated_at))}`,
    )
    .join("\n");
}

export function renderTopicList(topics: TopicRow[]): string {
  if (topics.length === 0) return muted("  (no topics)");
  const width = Math.max(8, ...topics.map((t) => t.name.length));
  return topics
    .map(
      (t) =>
        `  ${padAccent(t.name, width)}  ${uid(
          t.id,
          topics.map((x) => x.id),
        )}  ${muted(relativeTime(t.updated_at))}`,
    )
    .join("\n");
}

export function renderAuditTimeline(
  rows: (AuditRow & { projectName: string | null })[],
  showProject: boolean,
): string {
  if (rows.length === 0) return muted("  (no activity yet)");
  const actionW = Math.max(8, ...rows.map((r) => r.action.length));
  return rows
    .map((r) => {
      const when = muted(relativeTime(r.ts).padEnd(8));
      const act = padAccent(r.action, actionW);
      const prefix =
        showProject && r.entity_type !== "project" && r.projectName
          ? `${muted(`[${r.projectName}]`)} `
          : "";
      return `  ${when}  ${act}  ${prefix}${r.summary}`;
    })
    .join("\n");
}

export interface DiscoveryView {
  statePath: string;
  count: number;
  latest: ProjectRow[];
}

export function renderDiscovery(v: DiscoveryView): string {
  const pad = Math.max(
    "project".length,
    "audit".length,
    "topics".length,
    "task".length,
    "columns".length,
  );
  const lines: string[] = [];
  lines.push(`${bold("clidos")} ${muted("— local task tracking")}`);
  lines.push("");
  lines.push(
    `  ${padAccent("project", pad)}  manage projects   (${v.count} project${v.count === 1 ? "" : "s"})`,
  );
  lines.push(`  ${padAccent("audit", pad)}  view the global activity log`);
  lines.push(
    `  ${padAccent("topics", pad)}  manage a project's topics (-p <id-or-name>)`,
  );
  lines.push(
    `  ${padAccent("task", pad)}  manage a project's cards (-p <id-or-name>)`,
  );
  lines.push(
    `  ${padAccent("columns", pad)}  manage a project's columns (-p <id-or-name>)`,
  );
  if (v.latest.length > 0) {
    lines.push("");
    lines.push(heading("Latest projects"));
    lines.push(renderProjectBullets(v.latest));
    lines.push("");
    lines.push(note("Run `clidos project` for the full list."));
    lines.push(note(`State: ${v.statePath}`));
  } else {
    lines.push("");
    lines.push(
      note("No projects yet. Run `clidos project create <name>` to add one."),
    );
    lines.push(note(`State: ${v.statePath}`));
  }
  return lines.join("\n");
}

export function renderProjectCreated(name: string, id: string): string {
  return `${ok("✓")} Created project ${accent(name)} (${id})`;
}

export function renderProjectDefaultsApplied(result: {
  columns: number;
  topics: number;
}): string {
  const { columns, topics } = result;
  if (columns === 0 && topics === 0)
    return note("defaults already present (no changes)");
  const parts: string[] = [];
  if (columns > 0) parts.push(`${columns} column${columns === 1 ? "" : "s"}`);
  if (topics > 0) parts.push(`${topics} topic${topics === 1 ? "" : "s"}`);
  return `${ok("✓")} Added ${parts.join(", ")}`;
}

export function renderTopicCreated(name: string, id: string): string {
  return `${ok("✓")} Created topic ${accent(name)} (${id})`;
}

export function renderTopicRenamed(oldName: string, newName: string): string {
  return `${ok("✓")} Renamed topic ${muted(oldName)} → ${accent(newName)}`;
}

export function renderTopicArchived(name: string): string {
  return `${ok("✓")} Archived topic ${accent(name)}`;
}
