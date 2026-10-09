import type { TreeNode } from "./tree-view-types.ts";

function labelAttributes(node: TreeNode): boolean {
  return Boolean(
    node.summary || node.metadata?.length || node.status || node.surface,
  );
}

export function contractTree(roots: readonly TreeNode[]): {
  roots: TreeNode[];
  aliases: Map<string, string>;
} {
  const aliases = new Map<string, string>();
  const projected = new Map<TreeNode, TreeNode>();
  const rootSet = new Set(roots);
  const pending = [...roots];
  const ordered: TreeNode[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    ordered.push(node);
    pending.push(...(node.children ?? []));
  }
  for (const source of ordered.reverse()) {
    let node: TreeNode = {
      ...source,
      children: source.children?.map((child) => projected.get(child)!),
    };
    if (contractsChildren(source) && !labelAttributes(source) && !source.body) {
      const attributes = labelAttributes(source.children![0]!);
      if (
        !rootSet.has(source) ||
        (attributes && !source.children![0]!.metadata?.length)
      ) {
        const child = node.children![0]!;
        aliases.set(child.id, node.id);
        node = {
          ...child,
          id: node.id,
          label: `${node.label}${attributes ? ": " : "."}${child.label}`,
          labelJoined: attributes || child.labelJoined,
          bodyInline: Boolean(child.body) && child.defaultOpen === true,
          defaultOpen: node.defaultOpen ?? child.defaultOpen,
        };
      }
    }
    projected.set(source, node);
  }
  return { roots: roots.map((node) => projected.get(node)!), aliases };
}

export function contractsChildren(node: TreeNode | undefined): boolean {
  const child = node?.children?.length === 1 ? node.children[0] : undefined;
  return Boolean(child && child.defaultOpen !== false);
}

export function hasExpandableContent(node: TreeNode, inline = false): boolean {
  let current = node;
  for (;;) {
    if (
      current.bodyPreview ||
      (current.body &&
        ((!inline && node.defaultOpen === false) ||
          (current === node && !inline && !current.bodyInline) ||
          current.defaultOpen === false ||
          (!inline &&
            node.defaultOpen !== true &&
            current.defaultOpen !== true &&
            !current.bodyInline)))
    )
      return true;
    if (!contractsChildren(current)) return Boolean(current.children?.length);
    current = current.children![0]!;
  }
}
