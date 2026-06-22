/**
 * over-think-abort: abort the editor subagent when its thinking exceeds a token
 * budget.
 *
 * Active ONLY in the llm-editor `edit` child, and only when BUDGET_ENV is set
 * (the parent injects it solely for role=editor, never the viewer). In every
 * other context — the main agent, the viewer child, any non-print mode — it is
 * a dormant no-op: env absent → early return, no handler registered.
 *
 * Two paths: (1) STREAMED reasoning — count thinking_delta chars and abort
 * mid-flight; (2) NON-STREAMED reasoning — at message_end, thinking ≈
 * usage.output minus the answer text's tokens (pi folds reasoning into output,
 * no separate field). Both emit the same sentinel; the parent rejects either way.
 *
 * Leaf module: imports protocol.ts only. No tools, no globalThis, no state.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUDGET_ENV, CHARS_PER_TOKEN, overThinkLine, type OverThinkMode } from "./protocol.ts";

export default async function overThinkAbort(pi: ExtensionAPI): Promise<void> {
  const raw = process.env[BUDGET_ENV];
  const budget = raw ? Number(raw) : NaN;
  if (!Number.isFinite(budget) || budget <= 0) return; // not the editor child
  const budgetChars = budget * CHARS_PER_TOKEN;

  let thinkingChars = 0;
  let reported = false;

  // Emit the sentinel exactly once. The streaming path also aborts; the
  // message_end path does not (the answer already completed).
  const report = (mode: OverThinkMode, thinking: number): void => {
    if (reported) return;
    reported = true;
    try {
      process.stderr.write(overThinkLine(mode, budget, thinking));
    } catch {
      // best effort: the sentinel is diagnostic, not load-bearing
    }
  };

  // Streaming path (providers that surface reasoning as thinking_delta):
  // abort mid-flight to stop wasting tokens.
  pi.on("message_update", async (event: any, ctx: any) => {
    if (reported) return;
    const ev = event?.assistantMessageEvent;
    if (!ev || ev.type !== "thinking_delta") return;
    const d = typeof ev.delta === "string" ? ev.delta : "";
    if (!d) return;
    thinkingChars += d.length;
    if (thinkingChars <= budgetChars) return;
    report("abort", Math.floor(thinkingChars / CHARS_PER_TOKEN));
    try {
      ctx.abort();
    } catch {
      // best effort: the sentinel alone lets the parent detect the breach
    }
  });

  // Post-hoc path (providers that do NOT stream thinking_delta — reasoning is
  // folded into usage.output). thinking ≈ output − answer-text tokens. No abort:
  // the message already completed; the parent rejects + warns.
  pi.on("message_end", async (event: any) => {
    if (reported) return;
    const m = event?.message;
    if (!m || m.role !== "assistant") return;
    const u = m?.usage;
    if (!u || typeof u.output !== "number") return;
    const answerTokens = Math.ceil(answerTextChars(m) / CHARS_PER_TOKEN);
    const thinking = Math.max(0, u.output - answerTokens);
    if (thinking <= budget) return;
    report("warn", thinking);
  });
}

/** Char length of an assistant message's text content (the SEARCH/REPLACE answer). */
function answerTextChars(m: any): number {
  const c = m?.content;
  if (typeof c === "string") return c.length;
  if (!Array.isArray(c)) return 0;
  let n = 0;
  for (const b of c) if (b?.type === "text" && typeof b.text === "string") n += b.text.length;
  return n;
}
