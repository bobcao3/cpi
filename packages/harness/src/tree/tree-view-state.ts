import type { TreeNode, TreeState } from "./tree-view-types.ts";
import { contractsChildren } from "./tree-view-contract.ts";

export function expansionOwner(
  node: TreeNode,
  ids: ReadonlyMap<string, TreeNode>,
  parents: ReadonlyMap<string, string>,
): TreeNode {
  let parent = parents.get(node.id);
  while (parent && contractsChildren(ids.get(parent))) {
    node = ids.get(parent)!;
    parent = parents.get(node.id);
  }
  return node;
}

export function createTreeState(state?: Partial<TreeState>): TreeState {
  return {
    open: state?.open ?? new Map(),
    shownChildren: state?.shownChildren ?? new Map(),
    fullBodies: state?.fullBodies,
    lastExpansion: state?.lastExpansion,
    ...(state?.selectedId ? { selectedId: state.selectedId } : {}),
  };
}

export function markExpansion(
  state: TreeState,
  id: string,
  body: boolean,
): void {
  state.lastExpansion = { id, body, at: Date.now() };
}

export function pruneTreeState(
  state: TreeState,
  ids: ReadonlyMap<string, TreeNode>,
): void {
  for (const id of state.open.keys()) if (!ids.has(id)) state.open.delete(id);
  for (const id of state.shownChildren.keys())
    if (!ids.has(id)) state.shownChildren.delete(id);
  for (const id of state.fullBodies?.keys() ?? [])
    if (!ids.get(id)?.bodyPreview) state.fullBodies!.delete(id);
}

export function replacementSelection(
  oldSelected: string,
  oldParents: ReadonlyMap<string, string>,
  oldRows: readonly string[],
  ids: ReadonlyMap<string, TreeNode>,
): string | undefined {
  let ancestor = oldParents.get(oldSelected);
  while (ancestor) {
    if (ids.has(ancestor)) return ancestor;
    ancestor = oldParents.get(ancestor);
  }
  const index = oldRows.indexOf(oldSelected);
  for (let offset = 1; index >= 0 && offset < oldRows.length; offset++) {
    const next = oldRows[index + offset];
    if (next && ids.has(next)) return next;
    const previous = oldRows[index - offset];
    if (previous && ids.has(previous)) return previous;
  }
  return undefined;
}
