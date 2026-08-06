/**
 * Queue custom messages without triggering a turn: "beforeUser" lands before
 * the next user message, "afterToolResult" (steer) after the current tool
 * batch. Queues live on globalThis across reloads; core.ts owns the drains.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface PrependMessageOptions {
  /** Unique customType — used for dedup checking across reloads. */
  customType: string;
  content: string;
  once?: boolean;
  when?: (ctx: ExtensionContext) => boolean;
}

export type PrependDeliverAs = "beforeUser" | "afterToolResult";

export interface QueuedMessage {
  customType: string;
  content: string;
  display?: boolean;
  details?: unknown;
}

export interface QueueMessageOptions extends QueuedMessage {
  deliverAs?: PrependDeliverAs;
}

export function isFirstTurn(ctx: ExtensionContext): boolean {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user" || role === "assistant") return false;
  }
  return true;
}

function hasCustomMessage(ctx: ExtensionContext, customType: string): boolean {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === customType) return true;
  }
  return false;
}

export function prependMessage(
  pi: ExtensionAPI,
  options: PrependMessageOptions,
): void {
  const { customType, content, once = true, when } = options;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx) return;

    if (when && !when(ctx)) return;

    if (once && hasCustomMessage(ctx, customType)) return;

    pi.sendMessage({ customType, content });
  });
}

const Q_BEFORE_USER = "__cpiPrependBeforeUser";
const Q_AFTER_TOOL = "__cpiPrependAfterTool";

function queue(key: string): QueuedMessage[] {
  const g = globalThis as Record<string, unknown>;
  const arr = g[key];
  if (Array.isArray(arr)) return arr as QueuedMessage[];
  const fresh: QueuedMessage[] = [];
  g[key] = fresh;
  return fresh;
}

function deliver(
  pi: ExtensionAPI,
  m: QueuedMessage,
  deliverAs: PrependDeliverAs,
  triggerTurn: boolean,
): void {
  const message = {
    customType: m.customType,
    content: m.content,
    display: m.display ?? true,
    details: m.details,
  };
  if (deliverAs === "afterToolResult") {
    // Steer: lands after the current tool batch, before the next LLM call.
    pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
  } else {
    pi.sendMessage(message);
  }
}

export function drainBeforeUser(pi: ExtensionAPI): void {
  const items = queue(Q_BEFORE_USER).splice(0);
  for (const m of items) deliver(pi, m, "beforeUser", false);
}

export function drainAfterTool(pi: ExtensionAPI): void {
  const items = queue(Q_AFTER_TOOL).splice(0);
  if (items.length === 0) return;
  const last = items.length - 1;
  items.forEach((m, i) => deliver(pi, m, "afterToolResult", i === last));
}

export function queueMessage(options: QueueMessageOptions): void {
  const deliverAs = options.deliverAs ?? "beforeUser";
  const m: QueuedMessage = {
    customType: options.customType,
    content: options.content,
    display: options.display,
    details: options.details,
  };
  if (deliverAs === "afterToolResult") queue(Q_AFTER_TOOL).push(m);
  else queue(Q_BEFORE_USER).push(m);
}
