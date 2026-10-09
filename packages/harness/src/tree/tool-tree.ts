import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  type Component,
  Image,
  isImageLine,
  Markdown,
  Text,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { Diff } from "@earendil-works/pi-coding-agent";
import { treeBodyHint } from "../presentation/tree-hints.ts";
import { createTreeState } from "./tree-view-state.ts";
export { createTreeState } from "./tree-view-state.ts";
import {
  getMarkdownTheme,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";

import {
  TreeView,
  type TreeNode,
  type TreeState,
  type TreeStatus,
} from "./tree-view.ts";
export type { TreeState, TreeStatus } from "./tree-view.ts";

export interface ToolTreeContent {
  text: string;
  format?: "text" | "code" | "markdown" | "diff";
  language?: string;
  diffTone?: "added" | "removed";
  diffLineNumbers?: boolean | number;
  component?: Component;
  image?: { data: string; mimeType: string };
  renderHtml?: () => string;
}

export interface ToolTreeNode {
  id: string;
  label: string;
  summary?: string;
  metadata?: readonly string[];
  status?: TreeStatus;
  children?: readonly ToolTreeNode[];
  content?: ToolTreeContent;
  contentPreview?: ToolTreeContent;
  defaultOpen?: boolean;
  surface?: {
    background: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg";
    frame?: boolean;
  };
}

export interface ToolTreeNestedCall {
  toolCallId: string;
  parentToolCallId?: string;
  toolName: string;
  args: unknown;
  phase: "arguments" | "queued" | "running" | "complete";
  isError: boolean;
  result?: AgentToolResult<unknown>;
  durationMs?: number;
}

export interface ToolTreeSnapshot<TArgs = unknown, TDetails = unknown> {
  args: Partial<TArgs> | TArgs;
  result?: AgentToolResult<TDetails>;
  phase: "arguments" | "queued" | "running" | "complete";
  isError: boolean;
  durationMs?: number;
  nestedCalls?: readonly ToolTreeNestedCall[];
}

export interface ToolTreeContext<TState = Record<string, unknown>> {
  toolCallId: string;
  cwd: string;
  state: TState;
  viewState: TreeState;
  invalidate: () => void;
}

export interface ToolTreeBatchCall {
  toolCallId: string;
  snapshot: ToolTreeSnapshot;
  roots: readonly ToolTreeNode[];
}

export interface ToolTreeComponentOptions {
  state?: Partial<TreeState>;
  invalidate?: () => void;
  padding?: number;
  onCancel?: () => void;
  showImages?: boolean;
  imageWidthCells?: number;
}

type BodyCacheEntry = { key: string; body: Component; component?: Component };

const MAX_NODES = 2000;
const MAX_DEPTH = 48;
const MAX_TEXT = 200_000;

export class ToolTreeComponent implements Component {
  private roots: readonly ToolTreeNode[];
  private theme: Theme;
  private readonly viewState: TreeState;
  private readonly invalidateHost?: () => void;
  private padding: number;
  private readonly bodyCache = new Map<string, BodyCacheEntry>();
  private tree: TreeView;
  private readonly onCancel?: () => void;
  private showImages: boolean;
  private imageWidthCells: number;
  private inspecting = false;

  constructor(
    roots: readonly ToolTreeNode[],
    theme: Theme,
    options: ToolTreeComponentOptions = {},
  ) {
    this.roots = roots;
    this.theme = theme;
    this.onCancel = options.onCancel;
    this.showImages = options.showImages ?? true;
    this.imageWidthCells = options.imageWidthCells ?? 60;
    this.viewState =
      options.state?.open && options.state.shownChildren
        ? (options.state as TreeState)
        : createTreeState(options.state);
    this.invalidateHost = options.invalidate;
    this.padding = Math.max(0, Math.floor(options.padding ?? 1));
    this.tree = this.createTree(options.onCancel);
  }

  update(roots: readonly ToolTreeNode[], theme: Theme): void {
    this.roots = roots;
    if (this.theme !== theme) this.bodyCache.clear();
    this.theme = theme;
    this.tree.update(this.project());
    const ids = new Set<string>();
    const stack = [...roots];
    const seen = new Set<ToolTreeNode>();
    let count = 0;
    while (stack.length && count++ < MAX_NODES) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      ids.add(node.id);
      if (node.contentPreview) ids.add(`${node.id}\0preview`);
      stack.push(...(node.children ?? []).slice(0, MAX_NODES));
    }
    for (const [id, entry] of this.bodyCache)
      if (!ids.has(id)) {
        (entry.body as Component & { dispose?: () => void }).dispose?.();
        this.bodyCache.delete(id);
      }
  }

  dispose(): void {
    this.tree.dispose();
    for (const entry of this.bodyCache.values())
      (entry.body as Component & { dispose?: () => void }).dispose?.();
    this.bodyCache.clear();
  }

  setExpanded(expanded: boolean, force = false): void {
    this.tree.setExpanded(expanded, force);
  }

  setImageOptions(show: boolean, width: number): void {
    if (this.showImages === show && this.imageWidthCells === width) return;
    this.showImages = show;
    this.imageWidthCells = width;
    this.bodyCache.clear();
    this.tree.update(this.project());
  }

  reveal(id: string): void {
    this.tree.reveal(id);
  }
  getVisibleIds(): readonly string[] {
    return this.tree.getVisibleIds();
  }
  hasRunningRows(): boolean {
    const visible = new Set(this.tree.getVisibleIds());
    const stack = [...this.roots];
    const seen = new Set<ToolTreeNode>();
    let count = 0;
    while (stack.length && count++ < MAX_NODES) {
      const node = stack.pop()!;
      if (seen.has(node)) continue;
      seen.add(node);
      if (visible.has(node.id) && node.status === "running") return true;
      stack.push(...(node.children ?? []));
    }
    return false;
  }

  setPadding(padding: number): void {
    const next = Math.max(0, Math.floor(padding));
    if (this.padding === next) return;
    this.padding = next;
    this.invalidate();
  }

  getState(): TreeState {
    return this.viewState;
  }

  setInspecting(inspecting: boolean): void {
    if (this.inspecting === inspecting) return;
    this.inspecting = inspecting;
    this.tree.invalidate();
    this.invalidateHost?.();
  }

  getNodes(): readonly ToolTreeNode[] {
    return this.roots;
  }

  setFrame(frame: number): void {
    this.tree.setFrame(frame);
  }

  getRowPosition(id: string): number | undefined {
    const row = this.tree.getRowPosition(id);
    return row;
  }

  getSelectedId(): string | undefined {
    return this.tree.getSelectedId();
  }

  collapseLarge(): boolean {
    return this.tree.collapseLarge();
  }

  render(width: number, screenHeight?: number): string[] {
    const lines = this.tree.render(
      Math.max(0, width - this.padding),
      screenHeight,
    );
    if (this.padding === 0) return lines;
    const prefix = " ".repeat(Math.min(this.padding, Math.max(0, width)));
    return lines.map((line: string) =>
      isImageLine(line)
        ? `\x1b[${prefix.length}C${line}`
        : truncateToWidth(prefix + line, Math.max(0, width), ""),
    );
  }

  handleAction(action: "up" | "down" | "open" | "close" | "toggle"): void {
    this.tree.handleAction(action);
  }

  handleInput(data: string): void {
    this.tree.handleInput(data);
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.x < this.padding) return undefined;
    return this.tree.handleMouse({
      ...event,
      x: event.x - this.padding,
      width: Math.max(0, event.width - this.padding),
    });
  }

  invalidate(): void {
    this.tree.invalidate();
    this.invalidateHost?.();
  }

  private createTree(onCancel: (() => void) | undefined): TreeView {
    return new TreeView(this.project(), {
      state: this.viewState,
      onCancel: onCancel ?? this.onCancel,
      requestRender: this.invalidateHost,
      theme: {
        guide: (text: string) => this.theme.fg("borderMuted", text),
        status: (text: string, status: TreeStatus) =>
          this.styleStatus(text, status),
        selected: (text: string) =>
          this.inspecting ? this.theme.bg("selectedBg", text) : text,
      },
    });
  }

  private styleStatus(text: string, status: TreeStatus): string {
    if (status === "success") return this.theme.fg("success", text);
    if (status === "warning") return this.theme.fg("warning", text);
    if (status === "error" || status === "cancelled")
      return this.theme.fg("error", text);
    if (status === "running") return this.theme.fg("accent", text);
    return this.theme.fg("muted", text);
  }

  private project(): readonly TreeNode[] {
    const projected: TreeNode[] = [];
    const stack = this.roots
      .map((node) => ({ node, out: projected, depth: 0 }))
      .reverse();
    const seen = new Set<ToolTreeNode>();
    const ids = new Set<string>();
    let count = 0;
    while (stack.length) {
      const item = stack.pop()!;
      if (
        ++count >= MAX_NODES ||
        item.depth > MAX_DEPTH ||
        seen.has(item.node) ||
        ids.has(item.node.id)
      ) {
        item.out.push({
          id: "$tree-limit",
          label: "Invalid tree or display limit",
          status: "warning",
        });
        break;
      }
      seen.add(item.node);
      ids.add(item.node.id);
      const node = this.sanitizeNode(item.node);
      item.out.push(node);
      for (const child of [...(item.node.children ?? [])].reverse())
        stack.push({
          node: child,
          out: node.children as TreeNode[],
          depth: item.depth + 1,
        });
    }
    return projected;
  }

  private sanitizeNode(node: ToolTreeNode): TreeNode {
    const children: TreeNode[] = [];
    const surface = node.surface;
    return {
      id: node.id,
      label: this.sanitizeText(node.label),
      summary:
        node.summary === undefined
          ? undefined
          : this.sanitizeText(node.summary),
      metadata: node.metadata?.map((value: string) => this.sanitizeText(value)),
      status: node.status,
      children,
      body: node.content ? this.bodyFor(node.id, node.content) : undefined,
      bodyPreview: node.contentPreview
        ? this.bodyFor(`${node.id}\0preview`, node.contentPreview)
        : undefined,
      bodyExpansionHint: node.contentPreview
        ? (expanded, keyboardToggle, large) =>
            treeBodyHint(this.theme, expanded, keyboardToggle, large)
        : undefined,
      collapseHint: treeBodyHint(this.theme, true, false, true),
      defaultOpen: node.defaultOpen,
      surface: surface
        ? {
            background: (text) => this.theme.bg(surface.background, text),
            edge: surface.frame
              ? (position, width) =>
                  this.theme.style(
                    (position === "top" ? "▄" : "▀").repeat(width),
                    {
                      fg: this.theme.colors[surface.background],
                    },
                  )
              : undefined,
          }
        : undefined,
    };
  }

  private sanitizeText(text: string): string {
    return String(text)
      .slice(0, MAX_TEXT)
      .replace(
        /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g,
        "",
      );
  }

  private bodyFor(id: string, content: ToolTreeContent): Component {
    const text = this.sanitizeText(content.text);
    const format = content.format ?? "text";
    const key = `${format}\0${content.language ?? ""}\0${content.diffTone ?? ""}\0${content.diffLineNumbers ?? ""}\0${text}\0${this.theme.name ?? ""}\0${content.image?.data ?? ""}\0${content.image?.mimeType ?? ""}\0${this.showImages}\0${this.imageWidthCells}`;
    const cached = this.bodyCache.get(id);
    if (cached?.key === key && cached.component === content.component)
      return cached.body;
    const body =
      content.component ??
      (content.image && this.showImages
        ? new Image(
            content.image.data,
            content.image.mimeType,
            { fallbackColor: (text) => this.theme.fg("toolOutput", text) },
            { maxWidthCells: this.imageWidthCells },
          )
        : this.createBody(text, content));
    this.bodyCache.set(id, { key, body, component: content.component });
    return body;
  }

  private createBody(text: string, content: ToolTreeContent): Component {
    const { format, language } = content;
    if (format === "markdown")
      return new Markdown(text, 0, 0, getMarkdownTheme());
    if (format === "diff")
      return new Diff(text, {
        theme: this.theme,
        language,
        lineNumbers: content.diffLineNumbers,
      });
    if (format === "code")
      return new Text(
        highlightCode(text, language, {
          theme: this.theme,
          diff: content.diffTone,
        }).join("\n"),
        0,
        0,
      );
    return new Text(this.theme.fg("toolOutput", text), 0, 0);
  }
}

export {
  createGenericToolTree,
  mergeToolTreeNestedCalls,
} from "./tool-tree-generic.ts";
export { resolveToolTree } from "./tool-tree-resolver.ts";
