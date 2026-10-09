import type { ToolRenderers } from "../renderer-types.ts";
import {
  previewNode,
  resultImages,
  resultNotices,
  textOutput,
  toolStatus,
} from "./tree-content.ts";

export const BASH_UPDATE_THROTTLE_MS = 100;

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainder = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${remainder}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

function shellRenderers(prompt: string): ToolRenderers {
  return {
    renderTree(snapshot, theme, context) {
      const args = snapshot.args as { command?: string; timeout?: number };
      const id = context.toolCallId;
      let output = textOutput(snapshot);
      const details = snapshot.result?.details as
        | { fullOutputPath?: string; truncation?: { truncated?: boolean } }
        | undefined;
      if (
        snapshot.phase === "complete" &&
        details?.truncation?.truncated &&
        details.fullOutputPath &&
        output.endsWith("]")
      ) {
        const footer = output.lastIndexOf("\n\n[");
        if (
          footer !== -1 &&
          output.slice(footer).includes(details.fullOutputPath)
        )
          output = output.slice(0, footer).trimEnd();
      }
      const children = output
        ? [
            previewNode(
              `${id}/output`,
              "Output",
              { text: output },
              theme,
              5,
              "end",
            ),
          ]
        : [];
      children.unshift({
        id: `${id}/command`,
        label: "Command",
        content: {
          text: args.command ?? "",
          format: "code",
          language: prompt === "PS>" ? "powershell" : "bash",
        },
        defaultOpen: false,
      });
      children.push(
        ...resultNotices(id, snapshot.result?.details),
        ...resultImages(id, snapshot),
      );
      return [
        {
          id,
          label: prompt === "PS>" ? "powershell" : "bash",
          summary: args.command ?? "…",
          status: toolStatus(snapshot),
          metadata: [
            args.timeout ? `timeout ${args.timeout}s` : "",
            snapshot.durationMs !== undefined
              ? formatDuration(snapshot.durationMs)
              : "",
          ].filter(Boolean),
          children,
          defaultOpen: !snapshot.isError,
        },
      ];
    },
  };
}

const bashRenderers = shellRenderers("$");
const powershellRenderers = shellRenderers("PS>");

export function createShellRenderers(prompt: string): ToolRenderers {
  return prompt === "$"
    ? bashRenderers
    : prompt === "PS>"
      ? powershellRenderers
      : shellRenderers(prompt);
}
