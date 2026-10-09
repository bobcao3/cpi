import type { TreeNode } from "./tree-view-types.ts";
import { contractsChildren } from "./tree-view-contract.ts";
import { type FlatNode, MAX_ROWS } from "./tree-view-helpers.ts";

export function flattenTree(
  roots: readonly TreeNode[],
  parents: ReadonlyMap<string, string>,
  isOpen: (node: TreeNode) => boolean,
  shownCount: (id: string, total: number) => number,
): FlatNode[] {
  const result: FlatNode[] = [];
  const stack = [...roots].reverse().map((node, index) => ({
    node,
    depth: 0,
    flattened: false,
    ancestorLast: [] as boolean[],
    childIndex: roots.length - 1 - index,
    childCount: roots.length,
  }));
  while (stack.length > 0 && result.length < MAX_ROWS) {
    const item = stack.pop()!;
    result.push({ ...item, parentId: parents.get(item.node.id) });
    if (!isOpen(item.node)) continue;
    const children = item.node.children ?? [];
    const shown = shownCount(item.node.id, children.length);
    const hasMore = shown < children.length;
    const flattened = contractsChildren(item.node);
    for (let i = shown - 1; i >= 0; i--) {
      stack.push({
        node: children[i]!,
        depth: item.depth + 1,
        flattened,
        ancestorLast: flattened
          ? item.ancestorLast
          : [...item.ancestorLast, item.childIndex === item.childCount - 1],
        childIndex: flattened ? item.childIndex : i,
        childCount: flattened ? item.childCount : hasMore ? shown + 1 : shown,
      });
    }
  }
  return result;
}
