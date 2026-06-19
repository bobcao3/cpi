/**
 * AGENTS.md context discovery + global seen-tracking.
 *
 * pi loads project context files (AGENTS.md/CLAUDE.md) once at startup from
 * the session cwd and never reloads them. This module lets cpi surface
 * newly-entered trees' context files to the agent — both via the explicit
 * `set_cwd` tool and via `cd ... && ...` calls parsed out of shell commands.
 *
 *   - `discoverAgentsFiles(cwd)` mirrors pi's loader
 *     (resource-loader.js `loadProjectContextFiles`): cwd→root walk, first
 *     match per dir among AGENTS.md/AGENTS.MD/CLAUDE.md/CLAUDE.MD, deduped,
 *     root-first. Excludes the global agentDir file (cwd-independent, always
 *     in context).
 *   - `seedAgentsContext(cwd)` marks the startup tree as already-in-context
 *     so it is never re-surfaced. Called once at session_start.
 *   - `surfaceNewAgents(target)` returns files in target's tree not yet seen
 *     and records them, so each file surfaces at most once per process.
 *   - `formatAgentsBlock(files, header)` renders the shared
 *     `--- path ---\n<content>` block for tool results.
 *
 * State is backed by globalThis so it survives jiti extension reloads and is
 * shared across the cwd and shell extensions (same pattern as lib/footer.ts).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const CANDIDATES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const GLOBAL_KEY = "__cpiAgentsSeen";

export interface AgentsFile {
  path: string;
  content: string;
}

interface AgentsState {
  seen: Set<string>;
  seeded: boolean;
}

function state(): AgentsState {
  const g = globalThis as Record<string, unknown>;
  const s = g[GLOBAL_KEY] as AgentsState | undefined;
  if (s && typeof s === "object" && s.seen instanceof Set) return s;
  const fresh: AgentsState = { seen: new Set<string>(), seeded: false };
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

function loadFromDir(dir: string): AgentsFile | null {
  for (const name of CANDIDATES) {
    const p = join(dir, name);
    if (existsSync(p)) {
      try {
        return { path: p, content: readFileSync(p, "utf-8") };
      } catch {
        // unreadable — treat as absent, keep walking
      }
    }
  }
  return null;
}

/** Walk cwd→root, first match per dir, deduped, root-first (matches pi). */
export function discoverAgentsFiles(cwd: string): AgentsFile[] {
  const root = resolve("/");
  const seen = new Set<string>();
  const stack: AgentsFile[] = []; // cwd-first; reversed below
  let dir = resolve(cwd);
  for (;;) {
    const f = loadFromDir(dir);
    if (f && !seen.has(f.path)) {
      seen.add(f.path);
      stack.push(f);
    }
    if (dir === root) break;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const ordered: AgentsFile[] = [];
  for (let i = stack.length - 1; i >= 0; i--) ordered.push(stack[i]);
  return ordered;
}

/** Mark the startup tree (pi's already-loaded context) as seen. Idempotent. */
export function seedAgentsContext(cwd: string): void {
  const s = state();
  if (s.seeded) return;
  for (const f of discoverAgentsFiles(cwd)) s.seen.add(f.path);
  s.seeded = true;
}

/** Unseen AGENTS.md/CLAUDE.md files in target's tree; records them as seen. */
export function surfaceNewAgents(target: string): AgentsFile[] {
  const s = state();
  const surfaced = discoverAgentsFiles(target).filter((f) => !s.seen.has(f.path));
  for (const f of surfaced) s.seen.add(f.path);
  return surfaced;
}

/** Render surfaced files as a context block for a tool result. Empty if none. */
export function formatAgentsBlock(files: AgentsFile[]): string {
  if (files.length === 0) return "";
  let out = "";
  for (const f of files)
    out += `\n---\nsystem reminder | Project AGENTS.md loaded: ${f.path}\n${f.content}\n---`;
  return out;
}

/**
 * Mark every AGENTS.md/CLAUDE.md file in `target`'s tree as seen, without
 * returning/surfacing them. Used by `set_cwd` (which moves pi's process cwd,
 * so the system-prompt takeover already reflects the new tree next turn) to
 * preserve the seen-invariant: a later shell `cd` into that tree must not
 * re-surface files already shown by the system prompt.
 */
export function markAgentsSeen(target: string): void {
  const s = state();
  for (const f of discoverAgentsFiles(target)) s.seen.add(f.path);
}

/** Render files as pi's `<project_context>` block (matches buildSystemPrompt). */
export function renderProjectContextBlock(files: AgentsFile[]): string {
  if (files.length === 0) return "";
  let out = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const f of files) {
    out += `<project_instructions path="${f.path}">\n${f.content}\n</project_instructions>\n\n`;
  }
  out += "</project_context>\n";
  return out;
}

/**
 * Build the live `<project_context>` file set for the system prompt:
 *   - keep pi's non-project context files (the cwd-independent global
 *     agentDir file), and
 *   - replace the project files (the snapshot-cwd tree, which pi loaded at
 *     startup) with the live-cwd tree.
 * Deduped by path, global-first then root→liveCwd.
 *
 * `piContextFiles` is `systemPromptOptions.contextFiles`; `snapshotCwd` is
 * `systemPromptOptions.cwd` (pi's startup snapshot, possibly stale).
 */
export function liveContextFiles(
  piContextFiles: { path: string; content: string }[] | undefined,
  snapshotCwd: string,
  liveCwd: string,
): AgentsFile[] {
  const projectPaths = new Set(discoverAgentsFiles(snapshotCwd).map((f) => f.path));
  const kept: AgentsFile[] = [];
  const seen = new Set<string>();
  for (const f of piContextFiles ?? []) {
    if (projectPaths.has(f.path)) continue; // drop snapshot-tree project files
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    kept.push({ path: f.path, content: f.content });
  }
  for (const f of discoverAgentsFiles(liveCwd)) {
    if (seen.has(f.path)) continue;
    seen.add(f.path);
    kept.push(f);
  }
  return kept;
}


/**
 * The cpi project-context system-prompt transform (pure).
 *
 * Replaces pi's startup-snapshot `<project_context>` block with one derived
 * from the live cwd, and rewrites the "Current working directory" line to
 * the live cwd. Called every `before_agent_start` (once per user prompt) so
 * the system prompt follows `set_cwd` and survives compaction (the live cwd
 * is process-global and persists across session reloads).
 *
 * `options` is pi's `systemPromptOptions` (`.cwd` = snapshot, `.contextFiles`
 * = pi's loaded files); `liveCwd` is the current `getCwd()`.
 */
export function applyProjectContextTransform(sp: string, options: any, liveCwd: string): string {
  const files = liveContextFiles(options?.contextFiles, options?.cwd ?? liveCwd, liveCwd);
  let out = sp.replace(/<project_context>[\s\S]*?<\/project_context>\n?/, "");
  const block = renderProjectContextBlock(files);
  if (block) {
    out = out.includes("\nCurrent date:")
      ? out.replace(/\nCurrent date:/, block + "\nCurrent date:")
      : out.replace(/\s+$/, "") + block;
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.replace(
    /^Current working directory: .*$/m,
    `Current working directory: ${liveCwd.replace(/\\/g, "/")}`,
  );
}
