import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applySystemPromptTransforms } from "./lib/system-prompt.ts";

/**
 * Single owner of the system prompt.
 *
 * Other cpi extensions register transforms via `registerSystemPromptTransform`
 * (lib/system-prompt.ts) instead of each listening to `before_agent_start` and
 * returning a mutated `systemPrompt`. Pi dispatches `before_agent_start` to
 * every extension that returns a value; only this owner returns the final
 * system prompt, after applying all transforms in their declared `order`.
 */
export default function systemPromptOwnerExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    return { systemPrompt: applySystemPromptTransforms(event.systemPrompt, ctx, event.systemPromptOptions) };
  });
}
