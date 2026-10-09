import { matchesTreeKey } from "./keybindings.ts";
import {
  type Component,
  dispatchMouseEvent,
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
  MAX_ROWS,
} from "./tree-view-helpers.ts";
import { renderTreeLayout } from "./tree-view-layout.ts";
import { buildTreeIndex } from "./tree-view-index.ts";

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
  private hitRows: HitRow[] = [];
  private rowPositions = new Map<string, number>();
  private renderedWidth?: number;
  private renderedLines?: string[];

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
    this.pruneState();
    if (oldSelected && !this.ids.has(oldSelected))
      this.state.selectedId = this.replacementSelection(
        oldSelected,
        oldParents,
        oldRows,
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
    this.changed();
  }

  setFrame(frame: number): void {
    if (this.state.frame === frame) return;
    this.state.frame = frame;
    this.invalidateHeaders();
    this.requestRender?.();
  }

  reveal(id: string): void {
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
    for (const node of this.ids.values()) node.body?.invalidate();
  }

  private invalidateHeaders(): void {
    this.renderedWidth = undefined;
    this.renderedLines = undefined;
  }

  render(width: number): string[] {
    if (this.renderedLines && this.renderedWidth === width)
      return this.renderedLines;
    const safeWidth = Math.max(0, width);
    if (safeWidth === 0) {
      this.hitRows = [];
      this.rowPositions.clear();
      this.renderedWidth = width;
      this.renderedLines = [];
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
    );
    const lines = layout.lines;
    this.hitRows = layout.hits;
    this.rowPositions = layout.positions;
    this.renderedWidth = width;
    this.renderedLines = lines;
    return this.renderedLines;
  }

  handleInput(data: string): void {
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
    if (
      event.type === "wheel" ||
      event.type === "drag" ||
      event.type === "move"
    )
      return undefined;
    const hit = this.hitRows.find((row) => event.y === row.y);
    if (!hit) return undefined;
    if (
      hit.kind === "body" &&
      hit.body &&
      hit.bodyY !== undefined &&
      hit.bodyWidth !== undefined
    ) {
      if (event.x < hit.markerEnd || event.x >= hit.markerEnd + hit.bodyWidth)
        return undefined;
      const result = dispatchMouseEvent(hit.body, {
        ...event,
        x: event.x - hit.markerEnd,
        y: hit.bodyY,
        width: hit.bodyWidth,
        height: hit.bodyHeight ?? event.height,
      });
      if (!result) return undefined;
      return { ...result, focus: result.focus && Boolean(this.onCancel) };
    }
    if (
      event.button !== "left" ||
      (event.type !== "press" && event.type !== "click")
    )
      return undefined;
    if (hit.kind === "more") {
      if (event.type === "click") this.showMore(hit.id);
      return {
        handled: true,
        render: event.type === "click",
        focus: Boolean(this.onCancel),
      };
    }
    const onMarker = event.x >= hit.markerStart && event.x < hit.markerEnd;
    if (onMarker && this.canExpand(this.ids.get(hit.id)!)) {
      if (event.type === "click") this.toggle(hit.id);
      return { handled: true, focus: Boolean(this.onCancel) };
    }
    if (event.type === "press") return undefined;
    if (event.type === "click") this.select(hit.id);
    return { handled: true, focus: Boolean(this.onCancel) };
  }

  private rebuildIndex(): void {
    const { ids, parents } = buildTreeIndex(this.roots);
    this.ids = ids;
    this.parents = parents;
  }

  private buildFlat(): FlatNode[] {
    const result: FlatNode[] = [];
    const stack = [...this.roots].reverse().map((node, index) => ({
      node,
      depth: 0,
      ancestorLast: [] as boolean[],
      childIndex: this.roots.length - 1 - index,
      childCount: this.roots.length,
    }));
    while (stack.length > 0 && result.length < MAX_ROWS) {
      const item = stack.pop()!;
      result.push({
        node: item.node,
        depth: item.depth,
        ancestorLast: item.ancestorLast,
        childIndex: item.childIndex,
        childCount: item.childCount,
        parentId: this.parents.get(item.node.id),
      });
      if (!this.isOpen(item.node)) continue;
      const children = item.node.children ?? [];
      const shown = this.shownCount(item.node.id, children.length);
      const hasMore = shown < children.length;
      for (let i = shown - 1; i >= 0; i--) {
        const ancestorLast = [
          ...item.ancestorLast,
          item.childIndex === item.childCount - 1,
        ];
        stack.push({
          node: children[i]!,
          depth: item.depth + 1,
          ancestorLast,
          childIndex: i,
          childCount: hasMore ? shown + 1 : shown,
        });
      }
    }
    return result;
  }

  private isOpen(node: TreeNode): boolean {
    return (
      this.state.open.get(node.id) ??
      (this.state.expanded || Boolean(node.defaultOpen))
    );
  }

  private canExpand(node: TreeNode): boolean {
    return Boolean(node.body || (node.children && node.children.length > 0));
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
    const node = this.selectedNode();
    if (!node || !this.canExpand(node)) return;
    this.state.open.set(node.id, open);
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
    const node = this.ids.get(id);
    if (!node || !this.canExpand(node)) return;
    const open = !this.isOpen(node);
    this.state.open.set(id, open);
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

  private pruneState(): void {
    for (const id of this.state.open.keys())
      if (!this.ids.has(id)) this.state.open.delete(id);
    for (const id of this.state.shownChildren.keys())
      if (!this.ids.has(id)) this.state.shownChildren.delete(id);
  }

  private replacementSelection(
    oldSelected: string,
    oldParents: Map<string, string>,
    oldRows: string[],
  ): string | undefined {
    let ancestor = oldParents.get(oldSelected);
    while (ancestor) {
      if (this.ids.has(ancestor)) return ancestor;
      ancestor = oldParents.get(ancestor);
    }
    const index = oldRows.indexOf(oldSelected);
    for (let offset = 1; index >= 0 && offset < oldRows.length; offset++) {
      const next = oldRows[index + offset];
      if (next && this.ids.has(next)) return next;
      const previous = oldRows[index - offset];
      if (previous && this.ids.has(previous)) return previous;
    }
    return undefined;
  }

  private selectedNode(): TreeNode | undefined {
    return this.state.selectedId
      ? this.ids.get(this.state.selectedId)
      : undefined;
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
    if (this.state.selectedId && this.ids.has(this.state.selectedId)) return;
    this.state.selectedId = this.roots[0]?.id;
  }

  private changed(): void {
    this.invalidateHeaders();
    this.requestRender?.();
  }
}
