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

// ── Main API ────────────────────────────────────────────────────────────────

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
