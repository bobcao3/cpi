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
 * `read`/`write`/`edit` override the builtins by name (extension tools win), so
 * the built-in read/write/edit are fully replaced — no disable extension needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTool, editTool, writeTool } from "./tool.ts";
import { setThinkingApi } from "./model-select.ts";
import { unregisterSystemPromptTransform } from "../lib/system-prompt.ts";

const LEGACY_TRANSFORM_ID = "llm-editor-transcripts";

export default function llmEditorExtension(pi: ExtensionAPI): void {
  // The old <editor_transcripts> system-prompt transform registered its
  // closure in the globalThis registry; that closure survives a jiti reload
  // and would throw on every before_agent_start (its transcript_block TOML no
  // longer exists), so unregister it defensively.
  unregisterSystemPromptTransform(LEGACY_TRANSFORM_ID);

  setThinkingApi(pi);
  pi.registerTool(readTool);
  pi.registerTool(editTool);
  pi.registerTool(writeTool);
}
