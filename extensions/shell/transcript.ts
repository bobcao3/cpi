/**
 * Markdown transcript rendering for the shell-family tools (`sh`,
 * `sh_repeat_until`).
 *
 * Registered into the shared transcript registry (lib/transcript-registry.ts)
 * so the streaming markdown transcript shows the actual command in a ```bash
 * block with a terse meta suffix, instead of the default XML argument dump.
 * If the call lacks a `command` (malformed), the renderer defers to the default
 * by returning null.
 */

import {
  parseArgs,
  registerToolCallRenderer,
  type ToolCallBlock,
} from "../lib/transcript-registry.ts";

// The subset of tool-call arguments the shell-family tools accept.
interface ShellCallArgs {
  command?: string;
  describe?: string;
  interval?: number;
}

// Returns markdown lines, or null to defer to the default XML renderer.
function renderShellTranscriptCall(block: ToolCallBlock): string[] | null {
  const args = parseArgs(block) as ShellCallArgs;
  if (typeof args.command !== "string") return null;
  const head = `**${block.name}** \`${block.id ?? ""}\``;
  const meta: string[] = [];
  const desc = args.describe?.trim();
  if (desc) meta.push(`_${desc}_`);
  if (block.name === "sh_repeat_until" && args.interval != null) {
    meta.push(`every ${args.interval}s`);
    meta.push(`stop on non-zero exit`);
  }
  const suffix = meta.length ? " " + meta.join(" · ") : "";
  return [head + suffix, "```bash", args.command, "```", ""];
}

/** Register shell-family transcript renderers. Call once at extension load. */
export function registerShellTranscriptRenderers(): void {
  registerToolCallRenderer("sh", renderShellTranscriptCall);
  registerToolCallRenderer("sh_repeat_until", renderShellTranscriptCall);
}
