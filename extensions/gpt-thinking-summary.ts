/**
 * Reasoning-summary title — show each reasoning *summary* inline, per message.
 *
 * Some reasoning models expose only a short summary of their reasoning, not
 * the raw trace (OpenAI Responses reasoning models: the full reasoning is
 * encrypted and sent back as an opaque item, never shown). pi stores that
 * summary in a `thinking` content block. When thinking blocks are hidden, pi
 * renders a single global "Thinking..." label — the user must press ctrl-t
 * to read the summary.
 *
 * Replacing that global label with the summary is wrong: pi exposes only one
 * hidden-thinking label for the whole chat, so it would stamp the *current*
 * summary onto every past thinking block. Instead this extension rewrites
 * the finalized assistant message itself, per message:
 *
 *   thinking{summary, signature}  ->  text{summary as blockquote} + thinking{"", signature}
 *
 * The blockquote text block is always visible (shown directly, no ctrl-t
 * needed) and per-message, so history is never clobbered. The thinking block
 * is emptied so the "Thinking..." label disappears, but its `thinkingSignature`
 * is kept — the provider still receives the encrypted reasoning item for
 * multi-turn continuity (it only needs the signature, not the summary text).
 * The blockquote is stripped from outgoing LLM context in the `context` event
 * (a `structuredClone` of messages), so the model never sees the summary as
 * its own prior answer — zero context pollution.
 *
 * Gate (data-driven, not API-based): a thinking block is a *summary* iff its
 * `thinkingSignature` JSON-parses to a reasoning item whose `summary` array
 * carries non-empty text. That is exactly "has a thinking summary but no
 * [full] thinking content" — the OpenAI Responses summary feature. Full
 * reasoning traces are left untouched:
 *
 *   - A GLM/DeepSeek model served through a Responses-compatible API exposes
 *     its full reasoning (`content` / `reasoning_text`), with no `summary`
 *     item — so it is NOT treated as a summary and its private reasoning is
 *     never leaked as a blockquote.
 *   - Anthropic thinking has an opaque (non-JSON) signature — not a summary
 *     item — so it is left untouched.
 *   - Non-reasoning models have no thinking blocks at all.
 *
 * This is API-agnostic and future-proof: any model that genuinely exposes an
 * OpenAI-style reasoning summary gets the inline title; anything exposing a
 * full trace does not.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Marker stored on injected blockquote text blocks so the `context` handler
 *  can strip them from outgoing LLM context. Survives session JSONL storage
 *  and the `context` event's `structuredClone`. */
const SUMMARY_MARK = "__piReasoningSummary";

interface TextBlock {
  type: "text";
  text: string;
  [SUMMARY_MARK]?: true;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

type ContentBlock = TextBlock | ThinkingBlock | { type: string; [k: string]: unknown };

interface AssistantMessage {
  role: string;
  content?: ContentBlock[];
  [k: string]: unknown;
}

/** If `signature` is a Responses reasoning item that carries a non-empty
 *  `summary`, return that summary text; otherwise undefined (full trace, or
 *  not a summary item). This is the precise "has a thinking summary" signal. */
function reasoningSummaryText(signature: string | undefined): string | undefined {
  if (!signature) return undefined;
  let item: unknown;
  try {
    item = JSON.parse(signature);
  } catch {
    // Anthropic/opaque signatures are not JSON — not a summary item.
    return undefined;
  }
  if (item === null || typeof item !== "object") return undefined;
  const summary = (item as { summary?: unknown }).summary;
  if (!Array.isArray(summary)) return undefined;
  const text = summary
    .map((s) =>
      s !== null && typeof s === "object" && "text" in s
        ? String((s as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n\n");
  return text.trim() ? text : undefined;
}

/** Render a summary as a markdown blockquote (one `> ` per line) so it is
 *  visually distinct from the assistant's answer. */
function toBlockquote(summary: string): string {
  return summary
    .split("\n")
    .map((line) => "> " + line)
    .join("\n")
    .replace(/\s+$/, "");
}

/** Rewrite one assistant message's summary thinking blocks into an always-
 *  visible blockquote + an emptied (signature-only) thinking block. Full-trace
 *  thinking blocks (no summary item) are passed through unchanged. Returns
 *  the replacement message, or undefined if nothing changed. */
function transformSummaries(message: AssistantMessage): AssistantMessage | undefined {
  const content = message.content;
  if (!Array.isArray(content)) return undefined;
  let changed = false;
  const next: ContentBlock[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as ThinkingBlock).type === "thinking") {
      const tb = block as ThinkingBlock;
      const summary = reasoningSummaryText(tb.thinkingSignature);
      if (summary && typeof tb.thinking === "string" && tb.thinking.trim()) {
        next.push({
          type: "text",
          text: toBlockquote(summary),
          [SUMMARY_MARK]: true,
        });
        // Empty the thinking text so pi never renders the "Thinking..." label
        // for this block, but keep thinkingSignature for LLM continuity.
        next.push({ ...tb, thinking: "" });
        changed = true;
        continue;
      }
    }
    next.push(block);
  }
  return changed ? { ...message, content: next } : undefined;
}

/** Remove injected summary blockquote text blocks from a copy of the message
 *  list for outgoing LLM context (the `context` event works on a clone). */
function stripSummaries(messages: AssistantMessage[]): AssistantMessage[] | undefined {
  let changed = false;
  const result = messages.map((m) => {
    if (m?.role !== "assistant" || !Array.isArray(m.content)) return m;
    const kept = m.content.filter(
      (b) =>
        !(
          b &&
          typeof b === "object" &&
          (b as TextBlock).type === "text" &&
          (b as TextBlock)[SUMMARY_MARK]
        ),
    );
    if (kept.length === m.content.length) return m;
    changed = true;
    return { ...m, content: kept };
  });
  return changed ? result : undefined;
}

export default function gptThinkingSummaryExtension(pi: ExtensionAPI): void {
  // Per message: replace summary thinking blocks with an inline blockquote +
  // an emptied, signature-only thinking block. Gate is per-block (signature
  // carries a summary), so full-trace models are skipped automatically.
  pi.on("message_end", async (event: { message?: AssistantMessage }) => {
    if (event.message?.role !== "assistant") return;
    const replacement = transformSummaries(event.message);
    return replacement ? { message: replacement } : undefined;
  });

  // Per LLM call: strip the blockquote text blocks from outgoing context so
  // the model never sees its own reasoning summaries as prior answer text.
  pi.on("context", async (event: { messages: AssistantMessage[] }) => {
    const stripped = stripSummaries(event.messages);
    return stripped ? { messages: stripped } : undefined;
  });
}
