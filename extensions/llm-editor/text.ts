/**
 * Loader for all llm_editor textual content (system prompts, task templates,
 * tool metadata, schema descriptions, error/result messages, transcript
 * labels). Everything a person might read or tune lives in text.toml; the .ts
 * modules hold only logic + protocol markers.
 *
 * Layered, last-wins (project > user > shipped default), deep-merged via
 * lib/config's deepMerge (so a user/project file may override a single field,
 * e.g. just `system.viewer`). Cached per-cwd; jiti reload re-reads.
 * Pure leaf: node + smol-toml + lib/config (deepMerge only).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { deepMerge } from "../lib/config.ts";

export interface EditorText {
  system: { viewer: string; editor: string };
  tasks: { viewer: string; editor: string; editor_reconcile: string };
  tool: {
    label: string;
    description: string;
    prompt_snippet: string;
    guidelines: string[];
  };
  schema: { command: string; path: string; query: string; instruction: string; file_text: string };
  messages: {
    view_no_ranges: string;
    empty_dir: string;
    no_output: string;
    head_more: string;
    lines_omitted: string;
  };
  errors: Record<string, string>;
  transcript: {
    title: string;
    section_system: string;
    section_user: string;
    section_assistant: string;
    section_stderr: string;
  };
  system_prompt: { transcript_block: string };
}

const DEFAULT_PATH = fileURLToPath(new URL("./text.toml", import.meta.url));
const USER_PATH = join(process.env.HOME ?? "", ".pi", "agent", "cpi-editor-text.toml");

let cache: { cwd: string; text: EditorText } | null = null;

function readToml(path: string): Record<string, unknown> | null {
  if (!path || !existsSync(path)) return null;
  try {
    const obj = parseToml(readFileSync(path, "utf-8")) as unknown;
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch (err) {
    process.stderr.write(`[llm-editor] failed to parse text ${path}: ${err}\n`);
    return null;
  }
}

export function loadEditorText(cwd: string = process.cwd()): EditorText {
  if (cache && cache.cwd === cwd) return cache.text;
  const defaults = readToml(DEFAULT_PATH);
  if (!defaults) throw new Error(`[llm-editor] default text.toml missing at ${DEFAULT_PATH}`);
  const merged = deepMerge(
    deepMerge(defaults, readToml(USER_PATH) ?? {}),
    readToml(join(cwd, ".pi", "cpi-editor-text.toml")) ?? {},
  ) as EditorText;
  cache = { cwd, text: merged };
  return merged;
}

/** Substitute {name} placeholders with String(value); unknown placeholders kept literal. */
export function fmt(tpl: string, vars: Record<string, string | number>): string {
  return tpl.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
