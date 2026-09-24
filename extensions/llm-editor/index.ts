/** llm-editor: overrides pi's built-in read/write/edit by name (extension tools win); read/edit delegate reasoning to tool-less pi subagents, with a direct patch tool. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTool, editTool, writeTool, applyPatchTool } from "./tool.ts";
import { setThinkingApi } from "./model-select.ts";
import { unregisterSystemPromptTransform } from "../lib/system-prompt.ts";
import { registerReadGrouping } from "./read-render.ts";

const LEGACY_TRANSFORM_ID = "llm-editor-transcripts";

export default function llmEditorExtension(pi: ExtensionAPI): void {
  unregisterSystemPromptTransform(LEGACY_TRANSFORM_ID);

  registerReadGrouping(pi);

  setThinkingApi(pi);
  pi.registerTool(readTool);
  pi.registerTool(editTool);
  pi.registerTool(writeTool);
  pi.registerTool(applyPatchTool);
}
