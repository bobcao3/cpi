/** llm-editor text over lib/text.ts: all content lives in extensions/text/llm-editor.toml, layered with ~/.pi/agent and <cwd>/.pi overrides, deep-merged and cached per-cwd with mtime invalidation by loadText. Mustache {{name}} syntax, HTML-escaping disabled (plain text). */

import * as process from "node:process";
import { loadText, render, textPath } from "../lib/text.ts";

export interface ToolMeta {
  description: string;
  prompt_snippet: string;
  guidelines: string[];
}

export interface EditorText {
  system: {
    viewer: string;
    editor: string;
    editor_direct: string;
    editor_direct_retry: string;
    editor_fuzzy: string;
    editor_rewrite: string;
  };
  tasks: {
    viewer: string;
    editor: string;
    editor_direct: string;
    editor_direct_retry: string;
    editor_retry: string;
  };
  tool: { read: ToolMeta; write: ToolMeta; edit: ToolMeta };
  schema: {
    path: string;
    query: string;
    instruction: string;
    file_text: string;
  };
  completion: {
    view_complete: ToolMeta;
    edit_complete: ToolMeta;
    schema: {
      ranges: string;
      range_start: string;
      range_end: string;
      diffs: string;
      diff: string;
      content: string;
      cancel: string;
    };
  };
  messages: {
    view_no_ranges: string;
    empty_dir: string;
    no_output: string;
    head_more: string;
    lines_omitted: string;
  };
  lsp: {
    diagnostics_none: string;
    install_failed: string;
    restart_hint: string;
  };
  errors: Record<string, string>;
  transcript: {
    title: string;
    section_system: string;
    section_user: string;
    section_completion: string;
    section_stderr: string;
  };
}

/** Mustache render with HTML-escaping disabled. */
export const fmt = render;

export function loadEditorText(cwd: string = process.cwd()): EditorText {
  return loadText<EditorText>("llm-editor", textPath("llm-editor"), cwd);
}
