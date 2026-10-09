import { matchesTreeKey } from "./keybindings.ts";
import {
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

import type {
  TreeNode,
  TreeState,
  TreeViewOptions,
  TreeViewTheme,
} from "./tree-view-types.ts";
export type {
  TreeNode,
  TreeState,
  TreeStatus,
  TreeViewOptions,
  TreeViewTheme,
} from "./tree-view-types.ts";

import {
  CHILD_PAGE,
  emptyTheme,
  type FlatNode,
  type HitRow,
} from "./tree-view-helpers.ts";
import { renderTreeLayout } from "./tree-view-layout.ts";
import { buildTreeIndex } from "./tree-view-index.ts";
import { contractTree, hasExpandableContent } from "./tree-view-contract.ts";
import { flattenTree } from "./tree-view-flat.ts";
import { dispatchTreeMouse } from "./tree-view-mouse.ts";
import {
  collapseTreeHit,
  largeCollapseHit,
  registerTreeCollapse,
  screenRows,
  unregisterTreeCollapse,
} from "./tree-view-collapse.ts";
import {
  markExpansion,
  expansionOwner,
  pruneTreeState,
  replacementSelection,
} from "./tree-view-state.ts";

export class TreeView implements Component {
  private roots: readonly TreeNode[];
  private readonly state: TreeState;
  private readonly theme: Required<TreeViewTheme>;
  private readonly requestRender?: () => void;
  private readonly onCancel?: () => void;
  private readonly onSelectionChange?: (id: string) => void;
  private flat: FlatNode[] = [];
  private ids = new Map<string, TreeNode>();
  private parents = new Map<string, string>();
  private aliases = new Map<string, string>();
  private hitRows: HitRow[] = [];
  private rowPositions = new Map<string, number>();
  private renderedWidth?: number;
  private renderedHeight?: number;
  private renderedLines?: string[];
  private collapseActive = false;

  constructor(roots: readonly TreeNode[], options: TreeViewOptions = {}) {
    this.roots = roots;
    this.state = options.state ?? { open: new Map(), shownChildren: new Map() };
    this.theme = { ...emptyTheme, ...options.theme };
    this.requestRender = options.requestRender;
    this.onCancel = options.onCancel;
    this.onSelectionChange = options.onSelectionChange;
    this.rebuildIndex();
    this.ensureSelection();
  }

  update(roots: readonly TreeNode[]): void {
    const oldParents = this.parents;
    const oldRows = this.visibleHeaderIds();
    const oldSelected = this.state.selectedId;
    this.roots = roots;
    this.rebuildIndex();
    while (this.state.selectedId && this.aliases.has(this.state.selectedId))
      this.state.selectedId = this.aliases.get(this.state.selectedId)!;
    pruneTreeState(this.state, this.ids);
    if (
      oldSelected &&
      !this.ids.has(oldSelected) &&
      !this.aliases.has(oldSelected)
    )
      this.state.selectedId = replacementSelection(
        oldSelected,
        oldParents,
        oldRows,
        this.ids,
      );
    this.ensureSelection();
    const visible = new Set(this.visibleHeaderIds());
    while (this.state.selectedId && !visible.has(this.state.selectedId))
      this.state.selectedId = this.parents.get(this.state.selectedId);
    this.ensureSelection();
    this.invalidate();
    this.requestRender?.();
  }

  setExpanded(expanded: boolean, force = false): void {
    if (!force && this.state.expanded === expanded) return;
    this.state.expanded = expanded;
    this.state.open.clear();
    this.state.fullBodies?.clear();
    if (expanded && this.state.selectedId)
      markExpansion(this.state, this.state.selectedId, false);
    this.changed();
  }

  setFrame(frame: number): void {
    if (this.state.frame === frame) return;
    this.state.frame = frame;
    this.invalidateHeaders();
    this.requestRender?.();
  }

  reveal(id: string): void {
    while (this.aliases.has(id)) id = this.aliases.get(id)!;
    if (!this.ids.has(id)) return;
    let child = id;
    let parent = this.parents.get(id);
    while (parent) {
      const children = this.ids.get(parent)?.children ?? [];
      const index = children.findIndex((node) => node.id === child);
      if (index >= this.shownCount(parent, children.length))
        this.state.shownChildren.set(parent, index + 1);
      this.state.open.set(parent, true);
      child = parent;
      parent = this.parents.get(parent);
    }
    this.select(id);
    this.changed();
  }

  getSelectedId(): string | undefined {
    return this.state.selectedId;
  }

  getRowPosition(id: string): number | undefined {
    while (this.aliases.has(id)) id = this.aliases.get(id)!;
    if (!this.renderedLines) this.render(this.renderedWidth ?? 80);
    return this.rowPositions.get(id);
  }

  getVisibleIds(): readonly string[] {
    return this.visibleHeaderIds();
  }

  getState(): TreeState {
    return this.state;
  }

  invalidate(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
    for (const node of this.ids.values()) {
      node.body?.invalidate();
      node.bodyPreview?.invalidate();
    }
  }

  private invalidateHeaders(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
  }

  render(width: number, screenHeight = screenRows()): string[] {
    if (
      this.renderedLines &&
      this.renderedWidth === width &&
      this.renderedHeight === screenHeight
    ) {
      registerTreeCollapse(this.state, this, this.collapseActive);
      return this.renderedLines;
    }
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) {
      this.hitRows = [];
      this.collapseActive = false;
      this.rowPositions.clear();
      this.renderedWidth = width;
      this.renderedHeight = screenHeight;
      this.renderedLines = [];
      registerTreeCollapse(this.state, this, false);
      return this.renderedLines;
    }
    this.flat = this.buildFlat();
    this.hitRows = [];
    this.rowPositions = new Map();
    const layout = renderTreeLayout(
      this.flat,
      safeWidth,
      this.state,
      this.theme,
      (node) => this.isOpen(node),
      (id, count) => this.shownCount(id, count),
      screenHeight,
    );
    const lines = layout.lines;
    this.hitRows = layout.hits;
    this.collapseActive = this.hitRows.some((hit) => hit.large);
    this.rowPositions = layout.positions;
    this.renderedWidth = width;
    this.renderedHeight = screenHeight;
    this.renderedLines = lines;
    registerTreeCollapse(this.state, this, this.collapseActive);
    return this.renderedLines;
  }

  dispose(): void {
    unregisterTreeCollapse(this.state, this);
  }

  collapseLarge(): boolean {
    if (!this.renderedLines)
      this.render(
        this.renderedWidth ?? process.stdout.columns ?? 80,
        this.renderedHeight,
      );
    const hit = largeCollapseHit(this.hitRows, this.state);
    if (!hit) return false;
    this.collapseHit(hit);
    return true;
  }

  private collapseHit(hit: HitRow): void {
    collapseTreeHit(hit, this.state);
    if (hit.kind === "collapse") this.moveSelectionToVisibleAncestor(hit.id);
    this.changed();
  }

  handleInput(data: string): void {
    if (matchesTreeKey(data, "collapseLarge")) {
      this.collapseLarge();
      return;
    }
    if (matchesTreeKey(data, "cancel")) {
      this.onCancel?.();
      return;
    }
    for (const action of ["up", "down", "open", "close", "toggle"] as const) {
      if (matchesTreeKey(data, action)) {
        this.handleAction(action);
        return;
      }
    }
  }

  handleAction(action: "up" | "down" | "open" | "close" | "toggle"): void {
    const rows = this.visibleHeaderIds();
    const index = Math.max(0, rows.indexOf(this.state.selectedId ?? ""));
    if (action === "up") this.select(rows[Math.max(0, index - 1)]);
    else if (action === "down") this.selectNext(rows, index);
    else if (action === "open") this.openOrSelectChild();
    else if (action === "close") this.closeSelected();
    else this.toggleSelected();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return dispatchTreeMouse(this.hitRows, event, this.state, {
      canFocus: Boolean(this.onCancel),
      canExpand: (id) => this.canExpand(this.ids.get(id)!),
      toggle: (id) => this.toggle(id),
      more: (id) => this.showMore(id),
      collapse: (hit) => this.collapseHit(hit),
      select: (id) => this.select(id),
      changed: () => this.changed(),
    });
  }

  private rebuildIndex(): void {
    buildTreeIndex(this.roots);
    const contracted = contractTree(this.roots);
    this.roots = contracted.roots;
    this.aliases = contracted.aliases;
    const { ids, parents } = buildTreeIndex(this.roots);
    this.ids = ids;
    this.parents = parents;
  }

  private buildFlat(): FlatNode[] {
    return flattenTree(
      this.roots,
      this.parents,
      (node) => this.isOpen(node),
      (id, total) => this.shownCount(id, total),
    );
  }

  private expansionOwner(node: TreeNode): TreeNode {
    return expansionOwner(node, this.ids, this.parents);
  }

  private isOpen(node: TreeNode): boolean {
    node = this.expansionOwner(node);
    return (
      !this.canExpand(node) ||
      (this.state.open.get(node.id) ??
        (this.state.expanded || Boolean(node.defaultOpen)))
    );
  }

  private canExpand(node: TreeNode): boolean {
    return hasExpandableContent(this.expansionOwner(node));
  }

  private shownCount(id: string, total: number): number {
    return Math.min(total, this.state.shownChildren.get(id) ?? CHILD_PAGE);
  }

  private showMore(id: string): void {
    const node = this.ids.get(id);
    const total = node?.children?.length ?? 0;
    this.state.shownChildren.set(
      id,
      Math.min(total, this.shownCount(id, total) + CHILD_PAGE),
    );
    markExpansion(this.state, id, false);
    this.changed();
  }

  private selectNext(rows: string[], index: number): void {
    if (index < rows.length - 1) {
      this.select(rows[index + 1]);
      return;
    }
    const selected = this.state.selectedId;
    if (!selected) return;
    const parent = this.parents.get(selected);
    if (!parent) return;
    const node = this.ids.get(parent);
    const total = node?.children?.length ?? 0;
    if (this.shownCount(parent, total) >= total) return;
    this.showMore(parent);
    this.select(this.visibleHeaderIds()[index + 1]);
  }

  private openOrSelectChild(): void {
    const node = this.selectedNode();
    if (!node || !this.canExpand(node)) return;
    if (!this.isOpen(node)) {
      this.setSelectedOpen(true);
      return;
    }
    this.select(node.children?.[0]?.id);
  }

  private setSelectedOpen(open: boolean): void {
    const selected = this.selectedNode();
    if (!selected || !this.canExpand(selected)) return;
    const node = this.expansionOwner(selected);
    this.state.open.set(node.id, open);
    if (open) markExpansion(this.state, node.id, false);
    if (!open) this.moveSelectionToVisibleAncestor(node.id);
    this.changed();
  }

  private closeSelected(): void {
    const node = this.selectedNode();
    if (node && this.isOpen(node) && this.canExpand(node))
      this.setSelectedOpen(false);
    else if (this.state.selectedId)
      this.select(this.parents.get(this.state.selectedId));
  }

  private toggleSelected(): void {
    if (this.state.selectedId) this.toggle(this.state.selectedId);
  }

  private toggle(id: string): void {
    const selected = this.ids.get(id);
    if (!selected || !this.canExpand(selected)) return;
    const node = this.expansionOwner(selected);
    id = node.id;
    const open = !this.isOpen(node);
    this.state.open.set(id, open);
    if (open) markExpansion(this.state, id, false);
    if (!open) this.moveSelectionToVisibleAncestor(id);
    this.changed();
  }

  private moveSelectionToVisibleAncestor(id: string): void {
    let selected = this.state.selectedId;
    while (selected) {
      const parent = this.parents.get(selected);
      if (parent === id) {
        this.state.selectedId = id;
        this.onSelectionChange?.(id);
        return;
      }
      selected = parent;
    }
  }

  private selectedNode(): TreeNode | undefined {
    return this.ids.get(this.state.selectedId ?? "");
  }

  private select(id: string | undefined): void {
    if (!id || this.state.selectedId === id || !this.ids.has(id)) return;
    this.state.selectedId = id;
    this.onSelectionChange?.(id);
    this.changed();
  }

  private visibleHeaderIds(): string[] {
    return this.buildFlat().map((item) => item.node.id);
  }

  private ensureSelection(): void {
    while (this.state.selectedId && this.aliases.has(this.state.selectedId))
      this.state.selectedId = this.aliases.get(this.state.selectedId)!;
    if (this.state.selectedId && this.ids.has(this.state.selectedId)) return;
    this.state.selectedId = this.roots[0]?.id;
  }

  private changed(): void {
    this.invalidateHeaders();
    this.requestRender?.();
  }
}
