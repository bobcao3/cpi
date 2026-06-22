/**
 * Shared prompt-text loader + mustache renderer.
 *
 * Extraction target for cpi extension model-facing strings (tool descriptions,
 * prompt snippets/guidelines, system-prompt blocks, result messages). Ships
 * TOML defaults layered with user (`~/.pi/agent/<id>.toml`) and project
 * (`<cwd>/.pi/<id>.toml`) overrides, deep-merged via lib/config.deepMerge.
 *
 * Renderer: the real `mustache` package (spec-complete — sections, inverted
 * sections, array loops, partials, lambdas, standalone-tag whitespace
 * stripping). Prompts are plain text, not HTML, so HTML-escaping (mustache's
 * default) is disabled per-render via RenderOptions.escape: authors write
 * {{var}} naturally and `<`, `&`, backticks survive untouched. Standalone tags
 * (a line holding only a tag + whitespace) have their newline stripped, so a
 * switch conditional like {{#fd}} ... {{/fd}} on its own lines deletes cleanly
 * with no blank-line residue — that is what lets switch logic live entirely in
 * the template rather than in TS.
 *
 * Loader is cached per (id, cwd) keyed on file mtimes, so an edited TOML is
 * picked up on the next call without a jiti reload (module-level cache, like
 * llm-editor/text.ts — fine for a perf cache).
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import Mustache from "mustache";
import { deepMerge } from "./config.ts";

/** Uniform shape for a single-tool TOML ([tool] + [guidelines] tables). */
export interface ToolText {
  tool: { description: string; prompt_snippet: string };
  schema?: Record<string, string>;
  guidelines: { bullets: string[] };
}

const TEXT_DIR = fileURLToPath(new URL("../text/", import.meta.url));

/** Canonical shipped-TOML path for extension `id` inside extensions/text/. */
export function textPath(id: string): string {
  return join(TEXT_DIR, `${id}.toml`);
}

// ── Renderer ────────────────────────────────────────────────────────────────

const NO_ESCAPE = (text: string): string => text;

/**
 * Render a mustache template against `ctx`. HTML-escaping is disabled (prompts
 * are plain text); unknown names interpolate to "" and never throw. Full syntax:
 * https://mustache.github.io/mustache.5.html
 */
export function render(tpl: string, ctx: Record<string, unknown> | undefined): string {
  if (!tpl) return "";
  return Mustache.render(tpl, ctx ?? {}, undefined, { escape: NO_ESCAPE });
}

/**
 * Render each guideline template against `ctx`, dropping any that render to an
 * empty (or whitespace-only) string — e.g. a falsy inline `{{#switch}}…{{/}}`
 * section. Returns the surviving lines in order.
 */
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

// ── Loader ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  signature: string;
  data: Record<string, unknown>;
}
const cache = new Map<string, CacheEntry>();

function readToml(path: string): Record<string, unknown> | null {
  if (!path || !existsSync(path)) return null;
  try {
    const obj = parseToml(readFileSync(path, "utf-8")) as unknown;
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch (err) {
    process.stderr.write(`[cpi-text] failed to parse ${path}: ${err}\n`);
    return null;
  }
}

/** mtime signature so edits to any layer invalidate the cache without a reload. */
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

/**
 * Load + deep-merge the three TOML layers for `id`, returning the merged object
 * as `T`. Layer resolution:
 *   defaultPath                         (shipped defaults, required)
 *   ~/.pi/agent/<id>.toml               (user, all projects)
 *   <cwd>/.pi/<id>.toml                 (project, overrides user)
 * Cached per (id, cwd) keyed on file mtimes, so an edited TOML is picked up on
 * the next call without a jiti reload.
 */
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
  if (!defaults) throw new Error(`[cpi-text] default text missing at ${defaultPath}`);
  const merged = deepMerge(
    deepMerge(defaults, readToml(userPath) ?? {}),
    readToml(projectPath) ?? {},
  ) as Record<string, unknown>;
  cache.set(key, { signature: sig, data: merged });
  return merged as T;
}
