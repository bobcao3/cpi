/**
 * llm-editor: cpi's AI-mediated file tool.
 *
 * Replaces pi's built-in read/write/edit by fully overriding them with three
 * same-named tools — `read`, `write`, `edit` (no `command` enum; the tool name IS
 * the command); extension tools win in pi's registry, so the builtins are gone and
 * nothing needs disabling (disable-read-write-edit.ts is removed). The `read`
 * (with query) and `edit` paths delegate reasoning to tool-less `pi` subagents
 * (SWE-Edit, arXiv:2604.26102). `read` also inlines image files for vision models
 * (formerly the standalone read-media extension). Sole owner → registered
 * unconditionally at load; `pi.registerTool` is an idempotent Map.set on the fresh
 * instance, and a hot-reload re-registers them.
 *
 * Also registers a system-prompt transform (idempotent, reload-safe) that injects
 * the `<dir>/<id>.md` transcript convention, correcting itself if cwd/config
 * changes. The transform strips any prior block before re-applying, so hot
 * reloads and config edits never stack duplicates.
 *
 * `read`/`write`/`edit` override the builtins by name (extension tools win), so
 * the built-in read/write/edit are fully replaced — no disable extension needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSystemPromptTransform } from "../lib/system-prompt.ts";
import { loadEditorConfig } from "../lib/config.ts";
import { getCwd } from "../lib/cwd.ts";
import { resolveTranscriptDir } from "./log.ts";
import { loadEditorText, fmt } from "./text.ts";
import { readTool, editTool, writeTool } from "./tool.ts";
import { setThinkingApi } from "./model-select.ts";

const BLOCK_START = "<editor_transcripts>";
const BLOCK_END = "</editor_transcripts>";
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
  pi.registerTool(readTool);
  pi.registerTool(editTool);
  pi.registerTool(writeTool);
  registerSystemPromptTransform(TRANSFORM_ID, (prompt: string, ctx: any) => {
    const cwd = getCwd();
    const cfg = loadEditorConfig(cwd);
    const dir = resolveTranscriptDir(cfg.transcriptDir ?? "", cwd);
    const T = loadEditorText(cwd);
    const block = `${BLOCK_START}\n${fmt(T.system_prompt.transcript_block, { dir })}\n${BLOCK_END}`;
    return `${stripBlock(prompt).trimEnd()}\n\n${block}\n`;
  }, 200);
}