import pc from "picocolors";
import { renderUsage, type CommandDef } from "citty";
import type { ProjectRow } from "../core/db";
import type { TopicRow } from "../core/topics";
import type { AuditRow } from "../core/audit";
import { shortId } from "../core/id";

// Semantic styles — ANSI when color is supported (TTY / FORCE_COLOR), else
// markdown so piped/non-TTY output stays beautiful: *emphasis*, **strong**,
// # section, > note (per AGENTS.md). picocolors' isColorSupported is the single
// source of truth for "will color actually be emitted" — it is false when piped
// or under NO_COLOR, true in a TTY or with FORCE_COLOR.
const color: boolean = pc.isColorSupported;

const accent = (s: string) => (color ? pc.cyan(s) : `*${s}*`);
const muted = (s: string) => (color ? pc.dim(s) : s);
const bold = (s: string) => (color ? pc.bold(s) : `**${s}**`);
export const heading = (s: string) => (color ? pc.bold(pc.underline(s)) : `# ${s}`);
const note = (s: string) => (color ? pc.dim(s) : `> ${s}`);
const ok = (s: string) => (color ? pc.green(s) : s);

/** Pad `s` to `width` visible columns after applying `accent`. In non-TTY the
 *  *…* markup adds a constant 2 chars, which cancels across rows (each cell is
 *  width+2), so columns still line up; in TTY the ANSI codes are invisible. */
function padAccent(s: string, width: number): string {
  return accent(s) + " ".repeat(Math.max(0, width - s.length));
}

/** Strip ANSI/CSI escape sequences (cleans citty's renderUsage when piped). */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** The root command's meta, passed as `parent` to renderUsage so a grouping or
 *  leaf command renders its full path (e.g. "clidos project …"). Kept here to
 *  avoid a circular import of `main` into the command modules. */
export const ROOT_PARENT: CommandDef<any> = { meta: { name: "clidos", version: "0.1.0" } };

/** renderUsage, stripped of ANSI when color is off so piped usage is clean text. */
export async function renderUsageClean(cmd: CommandDef<any>, parent?: CommandDef<any>): Promise<string> {
  const out = await renderUsage(cmd, parent);
  return color ? out : stripAnsi(out);
}

/** The concise USAGE line only — fd-style `-h` short help: just
 *  `USAGE <path> <subcommands|args>`, no description/COMMANDS/etc. (`--help`
 *  gives the full renderUsage). */
export async function renderUsageShort(cmd: CommandDef<any>, parent?: CommandDef<any>): Promise<string> {
  const out = await renderUsage(cmd, parent);
  const lines = out.split("\n");
  const idx = lines.findIndex((l) => stripAnsi(l).startsWith("USAGE "));
  return idx >= 0 ? (lines[idx] ?? out) : out;
}

/** Render a millisecond timestamp as a short relative age. */
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

/** Render a project list: name (accent) + id (muted) + age (muted), + desc. */
export function renderProjectList(projects: ProjectRow[]): string {
  if (projects.length === 0) return muted("  (no projects)");
  const width = Math.max(8, ...projects.map((p) => p.name.length));
  return projects
    .map((p) => {
      const line = `  ${padAccent(p.name, width)}  ${muted(shortId(p.id, projects.map((x) => x.id)))}  ${muted(relativeTime(p.updated_at))}`;
      return p.description ? `${line}  ${p.description}` : line;
    })
    .join("\n");
}

/** Render the discovery "Latest projects" preview as `-- ` bullets: name
 *  (accent) + id (muted) + age (muted). A lighter preview than the full
 *  `renderProjectList` table used by `clidos project list`. */
export function renderProjectBullets(projects: ProjectRow[]): string {
  if (projects.length === 0) return muted("(no projects)");
  return projects
    .map((p) => `${muted("--")} ${accent(p.name)} ${muted(shortId(p.id, projects.map((x) => x.id)))} ${muted(relativeTime(p.updated_at))}`)
    .join("\n");
}

/** Render a topic list: name (accent) + id (muted) + age (muted). */
export function renderTopicList(topics: TopicRow[]): string {
  if (topics.length === 0) return muted("  (no topics)");
  const width = Math.max(8, ...topics.map((t) => t.name.length));
  return topics
    .map((t) => `  ${padAccent(t.name, width)}  ${muted(shortId(t.id, topics.map((x) => x.id)))}  ${muted(relativeTime(t.updated_at))}`)
    .join("\n");
}

/** Render an audit timeline. `showProject` prefixes non-project events with
 *  [ProjectName]; pass false for a single-project view (redundant otherwise). */
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
      const prefix = showProject && r.entity_type !== "project" && r.projectName
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

/** Render the bare-`clidos` discovery view (dashboard), styled to match citty's
 *  usage output: accent command names, muted meta, underlined section headers. */
export function renderDiscovery(v: DiscoveryView): string {
  const pad = Math.max("project".length, "audit".length, "topics".length);
  const lines: string[] = [];
  lines.push(`${bold("clidos")} ${muted("— local task tracking")}`);
  lines.push("");
  lines.push(`  ${padAccent("project", pad)}  manage projects   (${v.count} project${v.count === 1 ? "" : "s"})`);
  lines.push(`  ${padAccent("audit", pad)}  view the global activity log`);
  lines.push(`  ${padAccent("topics", pad)}  manage a project's topics (-p <id-or-name>)`);
  if (v.latest.length > 0) {
    lines.push("");
    lines.push(heading("Latest projects"));
    lines.push(renderProjectBullets(v.latest));
    lines.push("");
    lines.push(note("Run `clidos project` for the full list."));
    lines.push(note(`State: ${v.statePath}`));
  } else {
    lines.push("");
    lines.push(note("No projects yet. Run `clidos project create <name>` to add one."));
    lines.push(note(`State: ${v.statePath}`));
  }
  return lines.join("\n");
}

// --- one-line confirmations: green ✓ + accent the important noun, dim the id ---

/** ✓ Created project <name> (<id>) — name accented, id dimmed. */
export function renderProjectCreated(name: string, id: string): string {
  return `${ok("✓")} Created project ${accent(name)} ${muted(`(${id})`)}`;
}

/** ✓ Created topic <name> (<id>). */
export function renderTopicCreated(name: string, id: string): string {
  return `${ok("✓")} Created topic ${accent(name)} ${muted(`(${id})`)}`;
}

/** ✓ Renamed topic <old> → <new> — old dimmed, new accented. */
export function renderTopicRenamed(oldName: string, newName: string): string {
  return `${ok("✓")} Renamed topic ${muted(oldName)} → ${accent(newName)}`;
}

/** ✓ Archived topic <name>. */
export function renderTopicArchived(name: string): string {
  return `${ok("✓")} Archived topic ${accent(name)}`;
}
