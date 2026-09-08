import {
  parseArgs,
  registerToolCallRenderer,
  shortToolCallId,
  type ToolCallBlock,
} from "../lib/transcript-registry.ts";

interface ShellCallArgs {
  command?: string;
  describe?: string;
  description?: string;
  interval?: number;
}

function renderShellTranscriptCall(block: ToolCallBlock): string[] | null {
  const args = parseArgs(block) as ShellCallArgs;
  if (typeof args.command !== "string") return null;
  const meta: string[] = [];
  const desc = (args.describe ?? args.description)?.trim();
  if (desc) meta.push(`_${desc.replace(/\s+/g, " ")}_`);
  if (block.name === "sh_repeat_until" && args.interval != null) {
    meta.push(`every ${args.interval}s`);
    meta.push(`stop on non-zero exit`);
  }
  const head = `[${block.name}|${shortToolCallId(block.id, block.name)}]`;
  return [meta.length ? `${head}: ${meta.join(" · ")}` : head];
}

export function registerShellTranscriptRenderers(): void {
  registerToolCallRenderer("sh", renderShellTranscriptCall);
  registerToolCallRenderer("sh_repeat_until", renderShellTranscriptCall);
}
