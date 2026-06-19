/**
 * Prepend Message Utility
 *
 * Injects a custom message into the conversation history *before* the
 * next user message — without triggering an agent turn.
 *
 * Canonical mechanism:
 *
 *   before_agent_start  →  pi.sendMessage()  →  sendCustomMessage()
 *        │                      │                      │
 *        │                      │                      └─ agent.state.messages.push(msg)
 *        │                      │                         (synchronous, no turn)
 *        │                      │
 *        └─ fires before createContextSnapshot(),
 *           so the message lands in existing history,
 *           ahead of the current turn's messages array.
 *
 *   convertToLlm()  →  role: "custom"  →  role: "user"
 *
 * Result in the API payload:
 *
 *   [system] [nudge (user)] [actual user message] ...
 *                       ↑
 *                  injected here
 *
 * ── Extended: queued delivery at two drain points ──
 *
 * `queueMessage()` enqueues a custom message for delivery at one of two
 * points, without itself triggering a turn:
 *
 *   - "beforeUser"      → drained at `before_agent_start`; lands before the
 *                         next user message (same path as `prependMessage`).
 *   - "afterToolResult" → drained at `tool_execution_end` via
 *                         `pi.sendMessage({deliverAs:"steer"})`; lands after
 *                         the current turn's tool results, before the next
 *                         LLM call.
 *
 * This lets a producer that fires mid-turn (e.g. a tool result) still defer
 * delivery to "after the tool batch", and a producer that fires between turns
 * (e.g. a token-usage boundary) defer to "before the next user interaction".
 *
 * The two queues live on `globalThis` slots so they survive jiti reloads and
 * are shared across importing extensions (same pattern as lib/notification.ts
 * and lib/system-prompt.ts). Drain handlers are owned by the dedicated
 * `extensions/prepend-message.ts` extension (installed at load, re-installed on
 * its own reload); producers enqueue only and never install handlers.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PrependMessageOptions {
  /** Unique customType — used for dedup checking across reloads. */
  customType: string;
  /** Message content to inject (string or structured content parts). */
  content: string;
  /** Only inject once per session (default: true). */
  once?: boolean;
  /** Optional predicate — only inject when this returns true. */
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
  /** Drain point for the queued message. Default "beforeUser". */
  deliverAs?: PrependDeliverAs;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check whether there are existing user or assistant messages in the
 * session branch.  Returns `false` on the first turn, `true` afterwards.
 *
 * Useful as a `when` condition to restrict injection to the first turn.
 */
export function isFirstTurn(ctx: ExtensionContext): boolean {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role === "user" || role === "assistant") return false;
  }
  return true;
}

/**
 * Check whether a custom message with the given customType already
 * exists in the session branch (e.g. from a prior turn or reload).
 */
function hasCustomMessage(ctx: ExtensionContext, customType: string): boolean {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === customType) return true;
  }
  return false;
}

// ── One-shot prepend API ────────────────────────────────────────────────────

/**
 * Register a `before_agent_start` handler that prepends a custom message
 * into the conversation history before the next user message.
 *
 * The message is pushed into `agent.state.messages` (existing history)
 * via `pi.sendMessage()`, which does not trigger an agent turn.  Because
 * `before_agent_start` fires before `createContextSnapshot()`, the
 * injected message appears ahead of the current turn's messages in the
 * final LLM context.  `convertToLlm()` converts `role: "custom"` to
 * `role: "user"`, so the model sees it as a user message.
 *
 * @param pi      The extension API (from the factory function).
 * @param options Configuration for the prepend behaviour.
 */
export function prependMessage(pi: ExtensionAPI, options: PrependMessageOptions): void {
  const { customType, content, once = true, when } = options;

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!ctx) return;

    if (when && !when(ctx)) return;

    if (once && hasCustomMessage(ctx, customType)) return;

    pi.sendMessage({ customType, content });
  });
}

// ── Queued delivery API ────────────────────────────────────────────────────

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
    // Steer: delivered after the current turn's tool calls, before the next
    // LLM call. triggerTurn only matters when idle (it doesn't mid-turn), so
    // the caller passes it on the last item of a batch to wake an idle agent.
    pi.sendMessage(message, { deliverAs: "steer", triggerTurn });
  } else {
    // Not streaming at before_agent_start: synchronous append, no turn.
    pi.sendMessage(message);
  }
}

/**
 * Drain the before-user queue: deliver all enqueued "beforeUser" messages.
 * Lands before the next user message (no turn). Called by the dedicated owner
 * extension (extensions/prepend-message.ts) at `before_agent_start`.
 */
export function drainBeforeUser(pi: ExtensionAPI): void {
  const items = queue(Q_BEFORE_USER).splice(0);
  for (const m of items) deliver(pi, m, "beforeUser", false);
}

/**
 * Drain the after-tool queue: deliver all enqueued "afterToolResult" messages
 * via steer (lands after the current turn's tool results, before the next LLM
 * call). The last item triggers an idle wake. Called by the dedicated owner
 * extension (extensions/prepend-message.ts) at `tool_execution_end`.
 */
export function drainAfterTool(pi: ExtensionAPI): void {
  const items = queue(Q_AFTER_TOOL).splice(0);
  if (items.length === 0) return;
  const last = items.length - 1;
  items.forEach((m, i) => deliver(pi, m, "afterToolResult", i === last));
}

/**
 * Enqueue a custom message for deferred delivery. Does not install drain
 * handlers — that is owned by `extensions/prepend-message.ts`.
 *
 * - `deliverAs: "beforeUser"` (default): delivered before the next user
 *   message, at the next `before_agent_start`. Use for notifications raised
 *   between turns (e.g. context-window usage thresholds).
 * - `deliverAs: "afterToolResult"`: delivered after the current turn's tool
 *   results, before the next LLM call (via steer). Use for notifications
 *   raised by a tool that the model should see before its next action.
 */
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
