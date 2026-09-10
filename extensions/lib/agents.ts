/** AGENTS.md/CLAUDE.md discovery + global seen-tracking: pi loads project context files once at startup and never reloads, so cpi surfaces newly-entered trees' files. Seen-state lives on globalThis, surviving jiti reloads. */

import { accessSync, constants, readFileSync, statSync } from "node:fs";
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

function path_from_directory(directory: string): string | undefined {
  for (const name of CANDIDATES) {
    const path = join(directory, name);
    try {
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.R_OK);
      return path;
    } catch {
      continue;
    }
  }
}

/** Walk cwd→root, first match per dir, deduped, root-first (matches pi). */
export function discoverAgentsPaths(cwd: string): string[] {
  const paths: string[] = [];
  let directory = resolve(cwd);
  for (;;) {
    const path = path_from_directory(directory);
    if (path) paths.push(path);
    const parent = resolve(directory, "..");
    if (parent === directory) break;
    directory = parent;
  }
  return paths.reverse();
}

export function discoverAgentsFiles(cwd: string): AgentsFile[] {
  return discoverAgentsPaths(cwd).flatMap((path) => {
    try {
      return [{ path, content: readFileSync(path, "utf8") }];
    } catch {
      return [];
    }
  });
}

/** Mark the startup tree (pi's already-loaded context) as seen. Idempotent. */
export function seedAgentsContext(cwd: string): void {
  const s = state();
  if (s.seeded) return;
  for (const path of discoverAgentsPaths(cwd)) s.seen.add(path);
  s.seeded = true;
}

export function surfaceNewAgents(target: string): AgentsFile[] {
  const s = state();
  const surfaced = discoverAgentsFiles(target).filter(
    (f) => !s.seen.has(f.path),
  );
  for (const f of surfaced) s.seen.add(f.path);
  return surfaced;
}

export function formatAgentsBlock(files: AgentsFile[]): string {
  if (files.length === 0) return "";
  let out = "";
  for (const f of files)
    out += `\n---\nsystem reminder | Project AGENTS.md loaded: ${f.path}\n${f.content}\n---`;
  return out;
}
