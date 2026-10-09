import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "./tree/index.ts";
import { style_tool_tree } from "./lib/tool-style.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

export function renderWaitAnyTree(
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: Pick<ToolTreeContext, "toolCallId">,
): readonly ToolTreeNode[] {
  const raw =
    snapshot.result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const failed =
    snapshot.isError ||
    (snapshot.result as { isError?: boolean } | undefined)?.isError;
  return style_tool_tree(
    [
      {
        id: context.toolCallId,
        label: "wait_any",
        summary: failed ? "failed" : "waiting on events or user input",
        metadata: !failed && raw ? [raw] : [],
        status: failed
          ? "error"
          : snapshot.phase === "complete"
            ? "paused"
            : snapshot.phase === "running"
              ? "running"
              : "queued",
        defaultOpen: Boolean(failed),
        children: raw
          ? [
              {
                id: `${context.toolCallId}/${failed ? "failure" : "timestamp"}`,
                label: failed ? "Failure" : "Wait requested at",
                content: { text: raw },
                status: failed ? "error" : undefined,
                defaultOpen: Boolean(failed),
              },
            ]
          : [],
      },
    ],
    theme,
  );
}
