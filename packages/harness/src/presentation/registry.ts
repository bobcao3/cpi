import type { Component } from "@earendil-works/pi-tui";
import type { ToolTreeComponent } from "../tree/index.ts";
import { ToolTreeTicker } from "./tool-tree-ticker.ts";
import { resetTreeCollapse } from "../tree/tree-view-collapse.ts";

export interface ToolTreeInspectionTarget extends Component {
  getTreeComponent(): ToolTreeComponent | undefined;
}

interface PresentationState {
  tools: Set<ToolTreeInspectionTarget>;
  ticker: ToolTreeTicker;
  closeInspector?: () => void;
  changed?: () => void;
}

const state_key = Symbol.for("cpi.tool-tree.presentation.v1");
const shared = globalThis as typeof globalThis & {
  [state_key]?: PresentationState;
};
export const presentationState = (shared[state_key] ??= {
  tools: new Set(),
  ticker: new ToolTreeTicker(),
});
export const toolTreeTicker = presentationState.ticker;
const MAX_TOOLS = 1024;

export function registerToolTreeComponent(
  target: ToolTreeInspectionTarget,
): void {
  const tools = presentationState.tools;
  if (tools.has(target)) return;
  if (tools.size >= MAX_TOOLS) tools.delete(tools.values().next().value!);
  tools.add(target);
  presentationState.changed?.();
}

export function unregisterToolTreeComponent(
  target: ToolTreeInspectionTarget,
): void {
  if (presentationState.tools.delete(target)) presentationState.changed?.();
}

export function getToolTreeComponents(): readonly ToolTreeInspectionTarget[] {
  return [...presentationState.tools];
}

export function resetToolTreePresentation(): void {
  resetTreeCollapse();
  presentationState.closeInspector?.();
  toolTreeTicker.dispose();
  presentationState.tools.clear();
  presentationState.changed = undefined;
  presentationState.closeInspector = undefined;
}
