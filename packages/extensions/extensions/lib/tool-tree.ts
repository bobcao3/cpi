import type { ExtensionAPI } from "./tree-api.ts";
import {
  createAllToolRenderers,
  createGenericToolTree,
  type ToolDefinition,
  type ToolRenderers,
} from "../tree/index.ts";

export function register_tree_renderers(pi: ExtensionAPI): void {
  const builtins = createAllToolRenderers();
  pi.registerToolRenderer((name, next) => {
    const existing = next();
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (
      (existing as ToolDefinition | undefined)?.name === name &&
      pi
        .getAllTools()
        .some(
          (tool) =>
            tool.name === name && tool.sourceInfo.path === `builtin:${name}`,
        )
    ) {
      const builtin = builtins[name as keyof typeof builtins];
      if (builtin) return { ...builtin, name };
    }
    const mcp_definition = (
      existing as ToolDefinition | undefined
    )?.namespace?.name.startsWith("mcp__");
    if (
      existing?.renderTree ||
      existing?.renderExecution ||
      (!mcp_definition && (existing?.renderCall || existing?.renderResult))
    )
      return existing;
    const label = mcp ? `${mcp[1]}/${mcp[2]}` : name;
    return {
      renderShell: "self",
      renderTree(snapshot, theme, context) {
        return createGenericToolTree(snapshot, theme, context, label);
      },
    } satisfies ToolRenderers;
  });
}
