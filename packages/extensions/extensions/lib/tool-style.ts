import { type ToolTreeNode } from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export function style_tool_tree(
  roots: readonly ToolTreeNode[],
  theme: Theme,
): readonly ToolTreeNode[] {
  const pending = roots.map((node) => ({ node, root: true }));
  const styled = (text: string, color: Parameters<Theme["fg"]>[0]) =>
    text.includes("\x1b[") ? text : theme.fg(color, text);
  for (let count = 0; pending.length && count < 2000; count++) {
    const { node, root } = pending.pop()!;
    const color =
      node.status === "error" || node.status === "cancelled"
        ? "error"
        : node.status === "warning" ||
            node.status === "running" ||
            node.status === "queued"
          ? "warning"
          : root && (node.status === "success" || node.status === "detached")
            ? "success"
            : "muted";
    node.label = styled(node.label, color);
    if (node.summary) node.summary = styled(node.summary, "dim");
    node.metadata = node.metadata?.map((text) => styled(text, "muted"));
    if (
      node.content &&
      !node.content.component &&
      !node.content.image &&
      (!node.content.format || node.content.format === "text")
    )
      node.content = {
        ...node.content,
        component: new Text(
          theme.fg(
            node.status === "error" ? "error" : "toolOutput",
            node.content.text,
          ),
          0,
          0,
        ),
      };
    pending.push(
      ...(node.children ?? []).map((child) => ({ node: child, root: false })),
    );
  }
  return roots;
}
