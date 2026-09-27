/** Collapsed thinking renders as pi's "Thinking..." label; cpi labels it with a
 * lightbulb and drops the italics pi applies. */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const THINKING_LABEL = "💡 Thinking...";

const WIDGET_KEY = "cpi-thinking-block";
const STATE_KEY = "__cpiThinkingBlock";
const PATCHED = Symbol.for("cpi.thinkingBlock.patched");
const MAX_ATTEMPTS = 8;
const ITALIC_ON = "\x1b[3m";
const ITALIC_OFF = "\x1b[23m";

interface TreeNode {
  constructor?: { name?: string };
  children?: unknown[];
  child?: unknown;
  contentContainer?: { children?: unknown[] };
  paddingX?: number;
  text?: string;
  setText?: (text: string) => void;
  invalidate?: () => void;
  updateContent?: (message: unknown, isStreaming?: boolean) => void;
}

interface BlockState {
  done: boolean;
  attempts: number;
}

function state(): BlockState {
  const g = globalThis as Record<string, unknown>;
  if (!g[STATE_KEY]) g[STATE_KEY] = { done: false, attempts: 0 };
  return g[STATE_KEY] as BlockState;
}

const named = (node: unknown, name: string): boolean =>
  (node as TreeNode | undefined)?.constructor?.name === name;

function collect(root: unknown, name: string): TreeNode | undefined {
  const seen = new Set<unknown>();
  const stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const current = node as TreeNode;
    if (current.constructor?.name === name) return current;
    if (Array.isArray(current.children)) stack.push(...current.children);
  }
  return undefined;
}

/** Hidden thinking renders as a MouseRegion wrapping a plain Text. */
const isHiddenThinking = (node: unknown): boolean =>
  named(node, "MouseRegion") && named((node as TreeNode).child, "Text");

function normalizeThinking(instance: TreeNode): void {
  const children = instance.contentContainer?.children;
  if (!Array.isArray(children)) return;
  for (const child of children) {
    if (!isHiddenThinking(child)) continue;
    const label = (child as TreeNode).child as TreeNode | undefined;
    if (typeof label?.text === "string" && label.setText) {
      label.setText(
        label.text.replaceAll(ITALIC_ON, "").replaceAll(ITALIC_OFF, ""),
      );
    }
    if (label) {
      label.paddingX = 0;
      label.invalidate?.();
    }
  }
}

function patchMessage(instance: TreeNode): void {
  const proto = Object.getPrototypeOf(instance) as any;
  if (proto[PATCHED] || typeof proto.updateContent !== "function") return;
  const updateContent = proto.updateContent;
  proto.updateContent = function (
    this: TreeNode,
    message: unknown,
    isStreaming?: boolean,
  ): void {
    updateContent.call(this, message, isStreaming);
    normalizeThinking(this);
  };
  proto[PATCHED] = true;
}

export function patchThinkingBlock(tui: unknown): void {
  const s = state();
  if (s.done) return;
  const message = collect(tui, "AssistantMessageComponent");
  if (!message) return;
  patchMessage(message);
  s.done = true;
}

export function setupThinkingBlock(ctx: ExtensionContext): void {
  const s = state();
  if (s.done || !ctx.hasUI || ctx.mode !== "tui") return;
  if (s.attempts >= MAX_ATTEMPTS) return;
  s.attempts += 1;
  ctx.ui.setWidget(WIDGET_KEY, (tui) => {
    patchThinkingBlock(tui);
    return { render: () => [], invalidate: () => {} };
  });
  ctx.ui.setWidget(WIDGET_KEY, undefined);
  ctx.ui.setHiddenThinkingLabel(THINKING_LABEL);
}
