/** llm-editor text over lib/text.ts; overrides follow Pi's agent directory and the project directory. */

import { getCwd } from "../lib/cwd.ts";
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
    editor_fuzzy: string;
  };
  tasks: {
    viewer: string;
    editor: string;
    editor_correction: string;
  };
  tool: {
    read: ToolMeta;
    write: ToolMeta;
    edit: ToolMeta;
    apply_patch: ToolMeta;
  };
  schema: {
    path: string;
    read_path: string;
    query: string;
    instruction: string;
    file_text: string;
    patch: string;
  };
  messages: {
    view_no_ranges: string;
    empty_dir: string;
    no_output: string;
    head_more: string;
    lines_omitted: string;
    image_read: string;
    image_omitted: string;
    image_unsupported: string;
    video_note: string;
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
    section_completion_turn: string;
    section_correction_turn: string;
    section_stderr: string;
  };
}

/** Mustache render with HTML-escaping disabled. */
export const fmt = render;

export function loadEditorText(cwd: string = getCwd()): EditorText {
  return loadText<EditorText>("llm-editor", textPath("llm-editor"), cwd);
}
