/** AGENTS.md/CLAUDE.md discovery + global seen-tracking: pi loads project context files once at startup and never reloads, so cpi surfaces newly-entered trees' files. Seen-state lives on globalThis, surviving jiti reloads. */

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
  const stack: AgentsFile[] = [];
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
