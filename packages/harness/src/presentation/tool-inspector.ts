import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  type Component,
  type Keybinding,
  type KeyId,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import type { ToolTreeNode } from "../tree/index.ts";
import { render } from "../lib/text.ts";
import {
  getToolTreeComponents,
  presentationState,
  toolTreeTicker,
  type ToolTreeInspectionTarget,
} from "./registry.ts";

type Action =
  | "up"
  | "down"
  | "open"
  | "close"
  | "toggle"
  | "leave"
  | "nextRoot"
  | "previousRoot";
export interface ToolInspectorText {
  inspector: {
    description: string;
    empty: string;
    hint: string;
    shortcut: KeyId | "";
  };
  keys?: Partial<Record<Action, KeyId[]>>;
}
const bindings: Partial<Record<Action, Keybinding>> = {
  up: "tui.select.up",
  down: "tui.select.down",
  open: "tui.editor.cursorRight",
  close: "tui.editor.cursorLeft",
  toggle: "tui.select.confirm",
  leave: "tui.select.cancel",
  nextRoot: "tui.input.tab",
};

export class ToolInspector implements Component {
  private tool?: ToolTreeInspectionTarget;
  private top = 0;
  private height = 1;
  private followSelection = true;
  private closed = false;
  private readonly changed = () => this.ui.requestRender();

  constructor(
    private readonly ui: TUI,
    private readonly keybindings: KeybindingsManager,
    private readonly text: ToolInspectorText,
    private readonly done: () => void,
  ) {
    this.tool = getToolTreeComponents().at(-1);
    presentationState.changed = this.changed;
    toolTreeTicker.register(this);
  }

  private tree() {
    const tools = getToolTreeComponents();
    if (!this.tool || !tools.includes(this.tool)) {
      this.tool?.getTreeComponent()?.setInspecting(false);
      this.tool = tools.at(-1);
      this.top = 0;
    }
    const tree = this.tool?.getTreeComponent();
    tree?.setInspecting(true);
    return tree;
  }

  render(width: number): string[] {
    if (this.closed) return [];
    const tree = this.tree();
    const lines = this.tool?.render(width) ?? [];
    const id = tree?.getSelectedId();
    const row = id ? (tree?.getRowPosition(id) ?? 0) : 0;
    this.height = Math.max(1, Math.min(500, this.ui.terminal.rows - 7));
    this.top = Math.max(
      0,
      Math.min(this.top, Math.max(0, lines.length - this.height)),
    );
    if (this.followSelection) {
      if (row < this.top) this.top = row;
      if (row >= this.top + this.height) this.top = row - this.height + 1;
    }
    const keys = Object.fromEntries(
      (
        ["up", "down", "toggle", "nextRoot", "previousRoot", "leave"] as const
      ).map((action) => [
        action,
        [
          ...(bindings[action]
            ? this.keybindings.getKeys(bindings[action]!)
            : []),
          ...(this.text.keys?.[action] ?? []),
        ].join("/"),
      ]),
    );
    const hint = truncateToWidth(
      render(this.text.inspector.hint, keys),
      width,
      "",
    );
    return [
      hint,
      ...(lines.length
        ? lines.slice(this.top, this.top + this.height)
        : [truncateToWidth(this.text.inspector.empty, width, "")]),
    ];
  }

  private matches(data: string, action: Action): boolean {
    const binding = bindings[action];
    return (
      !!(binding && this.keybindings.matches(data, binding)) ||
      !!this.text.keys?.[action]
        ?.slice(0, 16)
        .some((key) => matchesKey(data, key))
    );
  }

  handleInput(data: string): void {
    if (this.matches(data, "leave")) return this.close();
    if (
      this.keybindings.matches(data, "tui.select.pageUp") ||
      this.keybindings.matches(data, "tui.select.pageDown")
    ) {
      this.top = Math.max(
        0,
        this.top +
          (this.keybindings.matches(data, "tui.select.pageUp") ? -1 : 1) *
            this.height,
      );
      this.followSelection = false;
    } else {
      this.followSelection = true;
      if (this.matches(data, "nextRoot")) this.moveRoot(1);
      else if (this.matches(data, "previousRoot")) this.moveRoot(-1);
      else {
        const tree = this.tree();
        if (!tree) return;
        const ids = tree.getVisibleIds();
        const selected = tree.getSelectedId();
        if (this.matches(data, "up") && selected === ids[0])
          this.moveTool(-1, true);
        else if (this.matches(data, "down") && selected === ids.at(-1))
          this.moveTool(1, false);
        else {
          const action = (
            ["up", "down", "open", "close", "toggle"] as const
          ).find((item) => this.matches(data, item));
          if (!action) return;
          tree.handleAction(action);
        }
      }
    }
    this.ui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "wheel") {
      this.top = Math.max(0, this.top + (event.wheelDelta ?? 0));
      this.followSelection = false;
      return { handled: true, render: true };
    }
    if (event.y < 1 || event.y > this.height) return undefined;
    const result = this.tree()?.handleMouse({
      ...event,
      y: event.y - 1 + this.top,
    });
    if (result?.handled) this.followSelection = true;
    return result;
  }

  private selectTool(tool: ToolTreeInspectionTarget, id?: string): void {
    this.tool?.getTreeComponent()?.setInspecting(false);
    this.tool = tool;
    this.top = 0;
    const tree = this.tree();
    if (id) tree?.reveal(id);
  }

  private moveTool(direction: number, last: boolean, root = false): void {
    const tools = getToolTreeComponents();
    let index = tools.indexOf(this.tool!);
    for (let count = 0; count < tools.length; count++) {
      index += direction;
      const tool = tools[index];
      if (!tool) return;
      const tree = tool.getTreeComponent();
      const ids = root
        ? tree
            ?.getNodes()
            .slice(0, 2000)
            .map((node) => node.id)
        : tree?.getVisibleIds();
      const id = last ? ids?.at(-1) : ids?.[0];
      if (id) return this.selectTool(tool, id);
    }
  }

  private moveRoot(direction: number): void {
    const tree = this.tree();
    const roots = tree?.getNodes().slice(0, 2000) ?? [];
    const selected = tree?.getSelectedId();
    const stack: Array<{ node: ToolTreeNode; root: number }> = roots.map(
      (node, root) => ({ node, root }),
    );
    const seen = new Set<ToolTreeNode>();
    let index = -1;
    for (let count = 0; stack.length && count < 2000; count++) {
      const item = stack.pop()!;
      if (seen.has(item.node)) continue;
      seen.add(item.node);
      if (item.node.id === selected) {
        index = item.root;
        break;
      }
      for (const node of (item.node.children ?? []).slice(
        0,
        Math.max(0, 2000 - stack.length),
      ))
        stack.push({ node, root: item.root });
    }
    const next = roots[index + direction];
    if (next && this.tool) this.selectTool(this.tool, next.id);
    else this.moveTool(direction, direction < 0, true);
  }

  needsAnimation(): boolean {
    return !this.closed && !!this.tree()?.hasRunningRows();
  }
  tick(): void {
    this.ui.requestRender();
  }
  invalidate(): void {
    if (!this.closed) this.tree()?.invalidate();
  }
  close(): void {
    if (!this.closed) {
      this.dispose();
      this.done();
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.tool?.getTreeComponent()?.setInspecting(false);
    toolTreeTicker.unregister(this);
    if (presentationState.changed === this.changed)
      presentationState.changed = undefined;
  }
}
