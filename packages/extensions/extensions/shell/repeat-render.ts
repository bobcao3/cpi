import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  faintWarning,
  renderShellTree,
  shellTreeDetail,
  shellTreeStatus,
  shellTreeVisible,
  type ShellTreeArgs,
  type ShellTreeDetails,
} from "./compact-render.ts";

interface RepeatArgs extends ShellTreeArgs {
  interval?: number;
}
export interface RepeatDetails extends ShellTreeDetails {
  description?: string;
  interval?: number;
}

export function renderRepeatTree(
  snapshot: ToolTreeSnapshot<RepeatArgs, RepeatDetails>,
  theme: Theme,
  context: Pick<ToolTreeContext, "toolCallId">,
): readonly ToolTreeNode[] {
  const details = snapshot.result?.details;
  const root = renderShellTree(snapshot, theme, context)[0]!;
  const interval = details?.interval ?? snapshot.args.interval;
  const failed = root.status === "error";
  const children = [...(root.children ?? [])];
  if (details?.id && !failed) {
    const id = `${context.toolCallId}/monitor`;
    children.push({
      id,
      label: faintWarning(theme, `Monitor ${shellTreeVisible(details.id)}`),
      summary: theme.fg("dim", "repeating at launch"),
      metadata: [`every ${interval ?? "?"}s`, "stops on non-zero exit"],
      children: [
        shellTreeDetail(
          id,
          "stop-condition",
          "Stop condition",
          "The monitor stops on a non-zero exit and repeats while the command exits with code zero.",
        ),
      ],
    });
  }
  return [
    {
      ...root,
      label: theme.fg(failed ? "error" : "warning", "sh_repeat_until"),
      summary: theme.fg(
        "dim",
        shellTreeVisible(
          details?.description ??
            details?.describe ??
            snapshot.args.description ??
            "shell",
        ),
      ),
      metadata: [
        details?.id
          ? faintWarning(theme, `Monitor ${shellTreeVisible(details.id)}`)
          : "",
        theme.fg("muted", `every ${interval ?? "?"}s`),
        theme.fg("muted", "stops on non-zero exit"),
      ].filter(Boolean),
      status: failed ? "error" : shellTreeStatus(snapshot),
      children,
    },
  ];
}
