/**
 * Loads and renders model-facing TOML text; escaping is disabled and
 * standalone tags are supported.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import Mustache from "mustache";
import { deepMerge } from "./config.ts";

export interface ToolText {
  tool: { description: string; prompt_snippet: string };
  schema?: Record<string, string>;
  guidelines: { bullets: string[] };
}

const TEXT_DIR = fileURLToPath(new URL("../text/", import.meta.url));

export function textPath(id: string): string {
  return join(TEXT_DIR, `${id}.toml`);
}

const NO_ESCAPE = (text: string): string => text;

// Unknown names render as "" and never throw.
export function render(
  tpl: string,
  ctx: Record<string, unknown> | undefined,
): string {
  if (!tpl) return "";
  return Mustache.render(tpl, ctx ?? {}, undefined, { escape: NO_ESCAPE });
}

export function renderLines(
  tpls: string[] | undefined,
  ctx: Record<string, unknown> | undefined,
): string[] {
  if (!tpls) return [];
  const out: string[] = [];
  for (const tpl of tpls) {
    const line = render(tpl, ctx);
    if (line.trim() !== "") out.push(line);
  }
  return out;
}

interface CacheEntry {
  signature: string;
  data: Record<string, unknown>;
}
const cache = new Map<string, CacheEntry>();

function readToml(path: string): Record<string, unknown> | null {
  if (!path || !existsSync(path)) return null;
  try {
    const obj = parseToml(readFileSync(path, "utf-8")) as unknown;
    return obj && typeof obj === "object"
      ? (obj as Record<string, unknown>)
      : null;
  } catch (err) {
    process.stderr.write(`[cpi-text] failed to parse ${path}: ${err}\n`);
    return null;
  }
}

function signature(paths: string[]): string {
  return paths
    .map((p) => {
      if (!existsSync(p)) return `${p}\x00missing`;
      try {
        const st = statSync(p);
        return `${p}\x00${st.mtimeMs}\x00${st.size}`;
      } catch {
        return `${p}\x00unreadable`;
      }
    })
    .join("\x01");
}

// Defaults, user, and project layers are deep-merged and cached by file signatures and cwd.
export function loadText<T = Record<string, unknown>>(
  id: string,
  defaultPath: string,
  cwd: string = process.cwd(),
): T {
  const userPath = join(process.env.HOME ?? "", ".pi", "agent", `${id}.toml`);
  const projectPath = join(cwd, ".pi", `${id}.toml`);
  const key = `${id}\x00${cwd}`;
  const paths = [defaultPath, userPath, projectPath];
  const sig = signature(paths);

  const hit = cache.get(key);
  if (hit && hit.signature === sig) return hit.data as T;

  const defaults = readToml(defaultPath);
  if (!defaults)
    throw new Error(`[cpi-text] default text missing at ${defaultPath}`);
  const merged = deepMerge(
    deepMerge(defaults, readToml(userPath) ?? {}),
    readToml(projectPath) ?? {},
  ) as Record<string, unknown>;
  cache.set(key, { signature: sig, data: merged });
  return merged as T;
}
