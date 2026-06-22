/**
 * Print-mode transcript + run-summary streamer.
 *
 * Active only in print mode (`pi -p`, i.e. subagent runs): streams the live
 * markdown transcript (one block per message, tool calls rendered via
 * lib/transcript-registry.ts) to stderr — the subagent's logs — instead of a
 * separate transcript file. The orchestrating agent tails the sh background log
 * (stderr) for the live transcript and the jsonl path; pi's stdout stays the
 * clean final answer.
 *
 *   session_start      -> stderr: `jsonl: <session jsonl path>`   (beginning)
 *   message_update     -> stderr: assistant text/thinking deltas   (live, token-by-token;
 *                         header `## Assistant _(provider/model)_` emitted on first delta)
 *   message_end (each) -> stderr: formatted block for user/toolResult, or for an
 *                         assistant message that streamed no deltas (non-streaming
 *                         provider); a streamed assistant skips the block (already
 *                         produced it) and emits a trailing newline so the
 *                         conclusion summary stays on its own filtered lines.
 *   session_shutdown   -> conclusion summary (jsonl path + time/turns/tokens),
 *                         written to $PI_SUBAGENT_SUMMARY (a temp file the
 *                         subagent wrapper cats after the answer) so it lands
 *                         at the very end, deterministically after the answer.
 *
 * Inactive (no-op) in tui/rpc/json modes.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderToolCallMarkdown, type ToolCallBlock } from "../lib/transcript-registry.ts";
import { getSubagentUsage, formatCost } from "../lib/cost-ledger.ts";
import { Type } from "typebox";

const SUMMARY_PATH = process.env.PI_SUBAGENT_SUMMARY;

// Per-run state. Print mode is single-shot (one session per process), so a
// plain module-level slot is sufficient (no cross-extension sharing needed).
let active = false;
let sessionFile = "(unknown)";
let startTimeMs = 0;
let turns = 0;
let inTokens = 0;
let outTokens = 0;
let costUsd = 0;
let streamed = false;
let asstTag = "";
let lastKind = "";
let editAction: "apply" | "cancel" | null = null;

function stderr(s: string): void {
  try {
    process.stderr.write(s);
  } catch {
    // best effort; never break the session over transcript I/O
  }
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

// Render one AgentMessage (same shape as the persisted jsonl record) to markdown.
function renderMessage(m: any): string {
  const out: string[] = [];
  const role = m?.role;
  if (role === "user") {
    out.push("## User", "", textOf(m.content) || "_(no text)_", "");
  } else if (role === "assistant") {
    const tag = m.model ? ` _(${m.provider ?? "?"}/${m.model})_` : "";
    out.push(`## Assistant${tag}`, "");
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "thinking" && c.thinking) {
        out.push("> " + String(c.thinking).replace(/\n/g, "\n> "), "");
      } else if (c.type === "text" && c.text) {
        out.push(c.text, "");
      } else if (c.type === "toolCall") {
        out.push(...renderToolCallMarkdown(c as ToolCallBlock));
      }
    }
  } else if (role === "toolResult") {
    const flag = m.isError ? " [error]" : "";
    out.push(
      `**result** ${m.toolName ?? ""} \`${m.toolCallId ?? ""}\`${flag}`,
      "",
      "```",
      textOf(m.content) || "(no output)",
      "```",
      "",
    );
  }
  return out.length ? out.join("\n") + "\n" : "";
}

// Accumulate token usage from an assistant message (canonical: sum across turns,
// matching pi's own export-html stats).
function tallyUsage(m: any): void {
  const u = m?.usage;
  if (!u) return;
  if (typeof u.input === "number") inTokens += u.input;
  if (typeof u.output === "number") outTokens += u.output;
  if (typeof u.cost?.total === "number") costUsd += u.cost.total;
}

function conclusionSummary(): string {
  const elapsed = ((Date.now() - startTimeMs) / 1000).toFixed(1);
  const sub = getSubagentUsage();
  const inT = inTokens + sub.input;
  const outT = outTokens + sub.output;
  const cost = costUsd + sub.cost;
  return `jsonl: ${sessionFile}\nsummary: time=${elapsed}s turns=${turns} in=${inT} out=${outT} cost=$${formatCost(cost)}\naction: ${editAction ?? "none"}\n`;
}

export default async function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    active = ctx.mode === "print" || !!process.env.PI_SUBAGENT;
    if (!active) return;
    sessionFile = ctx.sessionManager.getSessionFile() ?? "(unknown)";
    startTimeMs = Date.now();
    turns = 0;
    inTokens = 0;
    outTokens = 0;
    costUsd = 0;
    streamed = false;
    asstTag = "";
    editAction = null;
    stderr(`jsonl: ${sessionFile}\n`);
  });

  pi.on("turn_end", async (event) => {
    if (active) turns = event.turnIndex + 1;
  });

  pi.on("message_start", async (event) => {
    if (!active) return;
    const m = (event as { message: any }).message;
    if (m?.role !== "assistant") return;
    streamed = false;
    asstTag = m.model ? ` _(${m.provider ?? "?"}/${m.model})_` : "";
    lastKind = "";
  });

  pi.on("message_update", async (event) => {
    if (!active) return;
    const ev = (event as { assistantMessageEvent: any }).assistantMessageEvent;
    if (!ev) return;
    const t = typeof ev.type === "string" ? ev.type : "";
    if (t !== "text_delta" && t !== "thinking_delta" && t !== "toolcall_delta") return;
    if (!streamed) { stderr(`## Assistant${asstTag}\n\n`); streamed = true; }
    const kind = t === "thinking_delta" ? "thinking" : t === "text_delta" ? "text" : "toolcall";
    if (kind !== lastKind) {
      if (kind === "thinking") stderr("## Thinking\n\n");
      else if (lastKind === "thinking") stderr("\n\n");
      lastKind = kind;
    }
    const d = typeof ev.delta === "string" ? ev.delta : "";
    if (d) stderr(d);
  });

  pi.on("message_end", async (event) => {
    if (!active) return;
    const m = (event as { message: any }).message;
    if (m?.role === "assistant") tallyUsage(m);
    // A streamed assistant already emitted its header + text/thinking deltas
    // live; emit a single trailing newline (so the conclusion summary stays on
    // its own line for the renderer's `^(jsonl:|summary:)` filter) and skip
    // re-rendering the block to avoid duplicating the content.
    if (m?.role === "assistant" && streamed) {
      stderr("\n");
      return;
    }
    // Best effort: a render error must never skip the line or break the session.
    let md = "";
    try {
      md = renderMessage(m);
    } catch {
      md = "";
    }
    stderr(md);
  });

  pi.on("session_shutdown", async () => {
    if (!active) return;
    const summary = conclusionSummary();
    // Write to the wrapper's temp file so it lands after the answer; fall back to
    // stderr when no wrapper is involved (e.g. a direct `pi -p` run).
    if (SUMMARY_PATH) {
      try {
        writeFileSync(SUMMARY_PATH, summary);
        return;
      } catch {
        // fall through to stderr
      }
    }
    stderr(summary);
  });

  if (process.env.PI_SUBAGENT) {
    pi.registerTool({
      name: "edit-complete",
      label: "edit-complete",
      promptSnippet: "Signal edit completion (apply/cancel)",
      promptGuidelines: [],
      description: "Signal that your search-replace block(s) are complete. Call with action='apply' to apply the edit, or action='cancel' to abort without applying. This ends the edit turn.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("apply"), Type.Literal("cancel")]),
      }),
      async execute(_toolCallId, params) {
        editAction = params.action;
        return {
          content: [{ type: "text", text: params.action === "apply" ? "applying" : "cancelled" }],
          details: undefined,
          terminate: true,
        };
      },
    });
  }
}
