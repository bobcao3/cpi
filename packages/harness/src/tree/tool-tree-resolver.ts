import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./renderer-types.ts";
import type {
  ToolTreeContext,
  ToolTreeNode,
  ToolTreeSnapshot,
} from "./tool-tree.ts";
import { createGenericToolTree } from "./tool-tree-generic.ts";
import { createAllToolRenderers } from "./builtins/index.ts";

const builtInRenderers: Record<string, ToolRenderers> =
  createAllToolRenderers();

export function resolveToolTree(
  toolName: string,
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: ToolTreeContext,
  renderers?: ToolRenderers,
): readonly ToolTreeNode[] | undefined {
  const legacy = Boolean(renderers?.renderCall || renderers?.renderResult);
  if (
    legacy &&
    renderers?.renderTree === builtInRenderers[toolName]?.renderTree
  )
    return undefined;
  if (renderers?.renderTree) {
    try {
      return renderers.renderTree(snapshot, theme, context);
    } catch (error) {
      if (legacy) return undefined;
      const fallback = createGenericToolTree(
        snapshot,
        theme,
        context,
        toolName,
      );
      return [
        ...fallback,
        {
          id: `${context.toolCallId}/renderer-error`,
          label: "Tool presentation failed",
          status: "warning",
          content: {
            text: error instanceof Error ? error.message : String(error),
          },
        },
      ];
    }
  }
  if (legacy) return undefined;
  return createGenericToolTree(snapshot, theme, context, toolName);
}
