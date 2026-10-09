import type { TreeNode } from "./tree-view-types.ts";
import { MAX_DEPTH, MAX_NODES } from "./tree-view-helpers.ts";

export function buildTreeIndex(roots: readonly TreeNode[]): {
  ids: Map<string, TreeNode>;
  parents: Map<string, string>;
} {
  const ids = new Map<string, TreeNode>();
  const parents = new Map<string, string>();
  if (roots.length > MAX_NODES)
    throw new Error(`TreeView node limit ${MAX_NODES} exceeded`);
  const active = new Set<TreeNode>();
  const stack = [...roots]
    .reverse()
    .map((node) => ({ node, depth: 0, enter: true }));
  let count = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (!item.enter) {
      active.delete(item.node);
      continue;
    }
    if (active.has(item.node))
      throw new Error(`TreeView cycle at ${item.node.id}`);
    if (ids.has(item.node.id))
      throw new Error(`TreeView duplicate id ${item.node.id}`);
    if (++count > MAX_NODES)
      throw new Error(`TreeView node limit ${MAX_NODES} exceeded`);
    if (item.depth > MAX_DEPTH)
      throw new Error(`TreeView depth limit ${MAX_DEPTH} exceeded`);
    active.add(item.node);
    ids.set(item.node.id, item.node);
    stack.push({ node: item.node, depth: item.depth, enter: false });
    const children = item.node.children ?? [];
    if (children.length + count > MAX_NODES)
      throw new Error(`TreeView node limit ${MAX_NODES} exceeded`);
    for (let index = children.length - 1; index >= 0; index--) {
      const child = children[index]!;
      parents.set(child.id, item.node.id);
      stack.push({ node: child, depth: item.depth + 1, enter: true });
    }
  }
  return { ids, parents };
}
