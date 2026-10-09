import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "./tree/index.ts";
import { style_tool_tree } from "./lib/tool-style.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { cleanActivityDisplay } from "./lib/activity-details.ts";
import { fileLabel } from "./llm-editor/read-label.ts";

interface CwdDetails {
  cwd?: string;
  newAgentsFiles?: string[];
}

export function renderCwdTree(
  snapshot: ToolTreeSnapshot<{ path: string }, CwdDetails>,
  theme: Theme,
  context: Pick<ToolTreeContext, "toolCallId" | "cwd">,
): readonly ToolTreeNode[] {
  const { args, result, phase } = snapshot;
  const failed =
    snapshot.isError || (result as { isError?: boolean } | undefined)?.isError;
  const cwd = result?.details?.cwd;
  const files = result?.details?.newAgentsFiles ?? [];
  const children: ToolTreeNode[] = [];
  if (failed) {
    children.push({
      id: `${context.toolCallId}/failure`,
      label: "Failure",
      status: "error",
      defaultOpen: true,
      content: {
        text:
          result?.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n") ?? "failed",
      },
    });
    if (cwd)
      children.push({
        id: `${context.toolCallId}/unchanged`,
        label: "Current directory",
        summary: fileLabel(cwd, theme, "text", context.cwd),
        content: { text: cwd },
      });
  } else if (files.length) {
    children.push({
      id: `${context.toolCallId}/instructions`,
      label: "New project instructions",
      summary: `${files.length} files`,
      defaultOpen: true,
      children: files.map((path) => ({
        id: `${context.toolCallId}/instructions/${encodeURIComponent(path)}`,
        label: fileLabel(path, theme, "text", context.cwd),
        content: { text: path },
      })),
    });
  }
  return style_tool_tree(
    [
      {
        id: context.toolCallId,
        label: "set_cwd",
        summary:
          !failed && cwd
            ? fileLabel(cwd, theme, "dim", context.cwd)
            : cleanActivityDisplay(args.path ?? ""),
        status: failed
          ? "error"
          : phase === "complete"
            ? "success"
            : phase === "running"
              ? "running"
              : "queued",
        children,
        defaultOpen: Boolean(failed || files.length),
      },
    ],
    theme,
  );
}
