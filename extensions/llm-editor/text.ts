/**
 * llm-editor text: thin adapter over the shared lib/text.ts loader + mustache
 * renderer. All textual content (system prompts, task templates, tool
 * metadata, schema descriptions, messages, errors, transcript labels) lives in
 * extensions/text/llm-editor.toml, layered with ~/.pi/agent/llm-editor.toml
 * (user) and <cwd>/.pi/llm-editor.toml (project) overrides, deep-merged and
 * cached per-cwd with mtime invalidation by loadText.
 *
 * Templates use mustache {{name}} syntax (HTML-escaping disabled — prompts are
 * plain text, matching the prior fmt which also did not escape). `fmt` is
 * re-exported as `render` so existing call sites are unchanged; behavior is
 * equivalent because every placeholder is now substituted at a call site (the
 * one intentionally-literal token, <id> in the transcript_block, is plain text,
 * not a tag).
 */

import * as process from "node:process";
import { loadText, render, textPath } from "../lib/text.ts";

export interface EditorText {
  system: { viewer: string; editor: string; editor_fuzzy: string };
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
    over_think_warn: string;
  };
  lsp: { diagnostics_none: string; install_failed: string; restart_hint: string };
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

/** Mustache render with HTML-escaping disabled (alias kept for call sites). */
export const fmt = render;

/** Load the layered llm-editor TOML (cached per-cwd by loadText). */
export function loadEditorText(cwd: string = process.cwd()): EditorText {
  return loadText<EditorText>("llm-editor", textPath("llm-editor"), cwd);
}
