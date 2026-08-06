import {
  parseArgs,
  registerToolCallRenderer,
  shortToolCallId,
  type ToolCallBlock,
} from "../lib/transcript-registry.ts";

interface ShellCallArgs {
  command?: string;
  describe?: string;
  interval?: number;
}

function renderShellTranscriptCall(block: ToolCallBlock): string[] | null {
  const args = parseArgs(block) as ShellCallArgs;
  if (typeof args.command !== "string") return null;
  const head = `**${block.name}** \`${shortToolCallId(block.id, block.name)}\``;
  const meta: string[] = [];
  const desc = args.describe?.trim();
  if (desc) meta.push(`_${desc}_`);
  if (block.name === "sh_repeat_until" && args.interval != null) {
    meta.push(`every ${args.interval}s`);
    meta.push(`stop on non-zero exit`);
  }
  const suffix = meta.length ? " " + meta.join(" · ") : "";
  return [head + suffix, "```shell", args.command, "```", ""];
}

export function registerShellTranscriptRenderers(): void {
  registerToolCallRenderer("sh", renderShellTranscriptCall);
  registerToolCallRenderer("sh_repeat_until", renderShellTranscriptCall);
}
