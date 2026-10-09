import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { style_tool_tree } from "../lib/tool-style.ts";
import {
  faintWarning,
  shellTreeDetail,
  shellTreeStatus,
  shellTreeText,
  shellTreeVisible,
  type BackgroundTreeEntry,
} from "./compact-render.ts";

type TreeContext = Pick<ToolTreeContext, "toolCallId">;
function makeNode(
  id: string,
  label: string,
  fields: Partial<ToolTreeNode> = {},
): ToolTreeNode {
  return { id, label, ...fields };
}

function controlTree(
  snapshot: ToolTreeSnapshot<any, any>,
  context: TreeContext,
  kind: "signal" | "detach",
  theme: Theme,
): readonly ToolTreeNode[] {
  const details = snapshot.result?.details ?? {};
  const args = snapshot.args ?? {};
  const id = details.id ?? args.id ?? "";
  const description = shellTreeVisible(details.describe ?? "");
  const text = shellTreeText(snapshot);
  const failed = shellTreeStatus(snapshot) === "error";
  const children: ToolTreeNode[] = [];
  if (failed)
    children.push(
      shellTreeDetail(context.toolCallId, "failure", "Failure", text, "error"),
    );
  else if (snapshot.phase === "complete") {
    children.push(
      shellTreeDetail(context.toolCallId, "outcome", "Outcome", text),
    );
    if (kind === "detach") {
      if (details.logPath)
        children.push(
          shellTreeDetail(context.toolCallId, "log", "Log", details.logPath),
        );
      if (details.uid)
        children.push(
          shellTreeDetail(context.toolCallId, "uid", "UID", details.uid),
        );
      if (details.socketPath)
        children.push(
          shellTreeDetail(
            context.toolCallId,
            "socket",
            "Socket",
            details.socketPath,
          ),
        );
    }
  }
  const completed = snapshot.phase === "complete" && !failed;
  return [
    makeNode(
      context.toolCallId,
      theme.fg(
        failed ? "error" : completed ? "success" : "warning",
        kind === "signal" ? "sh_signal" : "sh_detach",
      ),
      {
        summary:
          (completed
            ? theme.fg(
                "text",
                kind === "signal"
                  ? `Sent ${details.signal ?? args.signal ?? "SIGINT"} to `
                  : "Detached ",
              )
            : "") +
          faintWarning(
            theme,
            id.startsWith("rpt-") ? `Monitor ${id}` : `PID=${id}`,
          ) +
          theme.fg("dim", description ? ` · ${description}` : ""),
        status:
          kind === "detach" && snapshot.phase === "complete" && !failed
            ? "detached"
            : shellTreeStatus(snapshot),
        metadata:
          kind === "signal"
            ? [details.signal ?? args.signal ?? "SIGINT"]
            : !failed && snapshot.phase === "complete"
              ? ["detached"]
              : [],
        children: style_tool_tree(children, theme),
        defaultOpen: false,
      },
    ),
  ];
}

export function renderSignalTree(
  snapshot: ToolTreeSnapshot<any, any>,
  theme: Theme,
  context: TreeContext,
): readonly ToolTreeNode[] {
  return controlTree(snapshot, context, "signal", theme);
}

export function renderDetachTree(
  snapshot: ToolTreeSnapshot<any, any>,
  theme: Theme,
  context: TreeContext,
): readonly ToolTreeNode[] {
  return controlTree(snapshot, context, "detach", theme);
}

export function renderBackgroundListTree(
  snapshot: ToolTreeSnapshot<
    Record<string, never>,
    { backgrounds?: BackgroundTreeEntry[]; repeats?: BackgroundTreeEntry[] }
  >,
  theme: Theme,
  context: TreeContext,
): readonly ToolTreeNode[] {
  const details = snapshot.result?.details;
  const backgrounds = details?.backgrounds ?? [];
  const repeats = details?.repeats ?? [];
  const entries = [
    ...backgrounds.map((entry) => ({ entry, repeat: false })),
    ...repeats.map((entry) => ({ entry, repeat: true })),
  ];
  const children = entries.map(({ entry, repeat }) => {
    const owner = `${context.toolCallId}/${repeat ? "monitor" : "process"}/${encodeURIComponent(entry.id)}`;
    const childNodes: ToolTreeNode[] = [];
    if (entry.command)
      childNodes.push(
        makeNode(`${owner}/command`, "Command", {
          content: { format: "code", language: "shell", text: entry.command },
        }),
      );
    if (entry.logPath)
      childNodes.push(shellTreeDetail(owner, "log", "Log", entry.logPath));
    if (entry.uid)
      childNodes.push(shellTreeDetail(owner, "uid", "UID", entry.uid));
    if (entry.socketPath)
      childNodes.push(
        shellTreeDetail(owner, "socket", "Socket", entry.socketPath),
      );
    return makeNode(
      owner,
      faintWarning(theme, repeat ? `Monitor ${entry.id}` : `PID=${entry.id}`),
      {
        summary: theme.fg("dim", shellTreeVisible(entry.describe ?? "")),
        metadata: [
          repeat ? "repeating at snapshot" : "running at snapshot",
          entry.intervalSec === undefined ? "" : `${entry.intervalSec}s`,
        ].filter(Boolean),
        children: style_tool_tree(childNodes, theme),
      },
    );
  });
  const count = `${backgrounds.length} background shells, ${repeats.length} monitors`;
  return [
    makeNode(
      context.toolCallId,
      theme.fg(snapshot.isError ? "error" : "success", "sh_background_ps"),
      {
        summary: theme.fg(
          "dim",
          entries.length ? count : "No background shells",
        ),
        status: shellTreeStatus(snapshot),
        children,
        content: entries.length
          ? undefined
          : { text: shellTreeText(snapshot) || count },
        defaultOpen: entries.length > 0,
      },
    ),
  ];
}
