/**
 * llm-editor: cpi's AI-mediated file tool.
 *
 * Replaces pi's built-in read/write/edit (disabled by disable-read-write-edit.ts)
 * with a single `llm_editor` tool whose `view` and `edit` commands delegate
 * reasoning to tool-less `pi` subagents (SWE-Edit, arXiv:2604.26102). Sole owner
 * of the tool → registered unconditionally at load; `pi.registerTool` is an
 * idempotent Map.set on the fresh instance, and a hot-reload re-registers it.
 *
 * Also registers a system-prompt transform (idempotent, reload-safe) that injects
 * the `<dir>/<id>.md` transcript convention, correcting itself if cwd/config
 * changes. The transform strips any prior block before re-applying, so hot
 * reloads and config edits never stack duplicates.
 *
 * disable-read-write-edit filters only read/write/edit by name, so llm_editor
 * stays active alongside it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSystemPromptTransform } from "../lib/system-prompt.ts";
import { loadEditorConfig } from "../lib/config.ts";
import { resolveTranscriptDir } from "./log.ts";
import { loadEditorText, fmt } from "./text.ts";
import { llmEditorTool } from "./tool.ts";
import { setThinkingApi } from "./model-select.ts";

const BLOCK_START = "<llm_editor_transcripts>";
const BLOCK_END = "</llm_editor_transcripts>";
const TRANSFORM_ID = "llm-editor-transcripts";

/** Strip a prior transcript block so re-application never stacks duplicates. */
function stripBlock(prompt: string): string {
  const start = prompt.indexOf(BLOCK_START);
  if (start < 0) return prompt;
  const end = prompt.indexOf(BLOCK_END, start);
  if (end < 0) return prompt;
  return prompt.slice(0, start) + prompt.slice(end + BLOCK_END.length);
}

export default function llmEditorExtension(pi: ExtensionAPI): void {
  setThinkingApi(pi);
  pi.registerTool(llmEditorTool);
  registerSystemPromptTransform(TRANSFORM_ID, (prompt: string, ctx: any) => {
    const cwd: string = ctx?.cwd ?? process.cwd();
    const cfg = loadEditorConfig(cwd);
    const dir = resolveTranscriptDir(cfg.transcriptDir ?? "", cwd);
    const T = loadEditorText(cwd);
    const block = `${BLOCK_START}\n${fmt(T.system_prompt.transcript_block, { dir })}\n${BLOCK_END}`;
    return `${stripBlock(prompt).trimEnd()}\n\n${block}\n`;
  }, 200);
}