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
  sessionId?: string;
  deliveryId?: string;
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

    pi.sendMessage({ customType, content, display: true, details: undefined });
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
  const details = m.deliveryId
    ? {
        ...(m.details && typeof m.details === "object" ? m.details : {}),
        deliveryId: m.deliveryId,
      }
    : m.details;
  const message = {
    customType: m.customType,
    content: m.content,
    display: m.display ?? true,
    details,
  };
  if (deliverAs === "afterToolResult") {
    // Steer: lands after the current tool batch, before the next LLM call.
    pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
  } else {
    pi.sendMessage(message);
  }
}

function takePending(
  ctx: ExtensionContext | undefined,
  key: string,
): QueuedMessage[] {
  const pending = queue(key);
  const items: QueuedMessage[] = [];
  for (let i = pending.length - 1; i >= 0; i--) {
    const m = pending[i];
    if (
      m.sessionId !== undefined &&
      (!ctx || m.sessionId !== ctx.sessionManager.getSessionId())
    )
      continue;
    pending.splice(i, 1);
    items.unshift(m);
  }
  return items.filter((m) => {
    if (!m.deliveryId || !ctx) return true;
    return !ctx.sessionManager
      .getEntries()
      .some(
        (entry) =>
          entry.type === "custom_message" &&
          entry.customType === m.customType &&
          (entry.details as { deliveryId?: string } | undefined)?.deliveryId ===
            m.deliveryId,
      );
  });
}

export function drainBeforeUser(
  pi: ExtensionAPI,
  ctx?: ExtensionContext,
): void {
  const items = takePending(ctx, Q_BEFORE_USER);
  for (const m of items) deliver(pi, m, "beforeUser", false);
}

export function drainAfterTool(pi: ExtensionAPI, ctx?: ExtensionContext): void {
  const items = takePending(ctx, Q_AFTER_TOOL);
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
    sessionId: options.sessionId,
    deliveryId: options.deliveryId,
  };
  const pending = queue(
    deliverAs === "afterToolResult" ? Q_AFTER_TOOL : Q_BEFORE_USER,
  );
  if (
    m.deliveryId &&
    pending.some(
      (item) =>
        item.customType === m.customType &&
        item.sessionId === m.sessionId &&
        item.deliveryId === m.deliveryId,
    )
  )
    return;
  pending.push(m);
}

export function discardQueuedMessages(customType: string): void {
  for (const key of [Q_BEFORE_USER, Q_AFTER_TOOL]) {
    const items = queue(key);
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].customType === customType) items.splice(i, 1);
    }
  }
}
