/** llm-editor: overrides pi's built-in read/write/edit by name (extension tools win); read/edit delegate reasoning to tool-less pi subagents. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTool, editTool, writeTool } from "./tool.ts";
import { setThinkingApi } from "./model-select.ts";
import { unregisterSystemPromptTransform } from "../lib/system-prompt.ts";

const LEGACY_TRANSFORM_ID = "llm-editor-transcripts";

export default function llmEditorExtension(pi: ExtensionAPI): void {
  unregisterSystemPromptTransform(LEGACY_TRANSFORM_ID);

  setThinkingApi(pi);
  pi.registerTool(readTool);
  pi.registerTool(editTool);
  pi.registerTool(writeTool);
}
