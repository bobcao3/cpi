import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./renderer-types.ts";
import type {
  ToolTreeBatchCall,
  ToolTreeContext,
  ToolTreeNode,
} from "./tool-tree.ts";

export const MAX_TOOL_TREE_BATCH_CALLS = 64;

export interface ToolTreeCallPresentation extends ToolTreeBatchCall {
  toolName: string;
  parentToolCallId?: string;
}

export function assembleToolTreeCalls(
  calls: readonly ToolTreeCallPresentation[],
  theme: Theme,
  context: ToolTreeContext,
): readonly ToolTreeNode[] {
  const resolve = context.state.toolRenderers as
    | ((name: string) => ToolRenderers | undefined)
    | undefined;
  context.state.treeBatchStates ??= new Map<string, Record<string, unknown>>();
  const states = context.state.treeBatchStates as Map<
    string,
    Record<string, unknown>
  >;
  const groups: ToolTreeCallPresentation[] = [];
  const limit = Math.min(calls.length, 256);
  for (let index = 0; index < limit; ) {
    const first = calls[index]!;
    const renderer = resolve?.(first.toolName);
    const members = [first];
    index++;
    if (renderer?.renderTree && renderer.renderBatchTree) {
      while (index < limit && members.length < MAX_TOOL_TREE_BATCH_CALLS) {
        const next = calls[index]!;
        if (
          next.toolName !== first.toolName ||
          next.parentToolCallId !== first.parentToolCallId
        )
          break;
        members.push(next);
        index++;
      }
    }
    if (members.length === 1) {
      groups.push(first);
      continue;
    }
    const id = `${first.toolCallId}/batch`;
    const state = states.get(id) ?? {};
    state.toolRenderers = resolve;
    states.set(id, state);
    const roots = renderer!.renderBatchTree!(members, theme, {
      ...context,
      toolCallId: id,
      state,
    });
    groups.push({ ...first, toolCallId: id, roots });
  }
  const owners = new Map<string, ToolTreeNode>();
  for (const group of groups) {
    const stack = [...group.roots];
    for (let count = 0; stack.length && count < 2000; count++) {
      const node = stack.pop()!;
      if (owners.has(node.id)) continue;
      owners.set(node.id, node);
      stack.push(
        ...(node.children ?? []).slice(0, Math.max(0, 2000 - stack.length)),
      );
    }
  }
  const parents = new Map(
    calls.map((call) => [call.toolCallId, call.parentToolCallId]),
  );
  const result: ToolTreeNode[] = [];
  for (const group of groups) {
    let parentId = group.parentToolCallId;
    let cyclic = false;
    for (let depth = 0; parentId && depth <= 256; depth++) {
      if (parentId === group.toolCallId || depth === 256) {
        cyclic = true;
        break;
      }
      parentId = parents.get(parentId);
    }
    const parent =
      !cyclic && group.parentToolCallId !== context.toolCallId
        ? owners.get(group.parentToolCallId ?? "")
        : undefined;
    if (parent && !group.roots.includes(parent)) {
      const childIds = new Set(
        (parent.children ?? []).map((child) => child.id),
      );
      parent.children = [
        ...(parent.children ?? []),
        ...group.roots.filter((root) => !childIds.has(root.id)),
      ];
    } else {
      if (cyclic && group.roots[0])
        group.roots[0].children = [
          ...(group.roots[0].children ?? []),
          {
            id: `${group.toolCallId}/parent-error`,
            label: "Invalid nested parent relationship",
            status: "warning",
          },
        ];
      result.push(...group.roots);
    }
  }
  return result;
}
