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
 *   message_end (each) -> stderr: formatted transcript block       (live)
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

const SUMMARY_PATH = process.env.PI_SUBAGENT_SUMMARY;

// Per-run state. Print mode is single-shot (one session per process), so a
// plain module-level slot is sufficient (no cross-extension sharing needed).
let active = false;
let sessionFile = "(unknown)";
let startTimeMs = 0;
let turns = 0;
let inTokens = 0;
let outTokens = 0;

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
    out.push("## 👤 User", "", textOf(m.content) || "_(no text)_", "");
  } else if (role === "assistant") {
    const tag = m.model ? ` _(${m.provider ?? "?"}/${m.model})_` : "";
    out.push(`## 🤖 Assistant${tag}`, "");
    for (const c of Array.isArray(m.content) ? m.content : []) {
      if (c.type === "thinking" && c.thinking) {
        out.push("> 💭 " + String(c.thinking).replace(/\n/g, "\n> "), "");
      } else if (c.type === "text" && c.text) {
        out.push(c.text, "");
      } else if (c.type === "toolCall") {
        out.push(...renderToolCallMarkdown(c as ToolCallBlock));
      }
    }
  } else if (role === "toolResult") {
    const flag = m.isError ? " ❌" : "";
    out.push(
      `↳ **result** ${m.toolName ?? ""} \`${m.toolCallId ?? ""}\`${flag}`,
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
}

function conclusionSummary(): string {
  const elapsed = ((Date.now() - startTimeMs) / 1000).toFixed(1);
  return `jsonl: ${sessionFile}\nsummary: time=${elapsed}s turns=${turns} in=${inTokens} out=${outTokens}\n`;
}

export default async function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    active = ctx.mode === "print";
    if (!active) return;
    sessionFile = ctx.sessionManager.getSessionFile() ?? "(unknown)";
    startTimeMs = Date.now();
    turns = 0;
    inTokens = 0;
    outTokens = 0;
    stderr(`jsonl: ${sessionFile}\n`);
  });

  pi.on("turn_end", async (event) => {
    if (active) turns = event.turnIndex + 1;
  });

  pi.on("message_end", async (event) => {
    if (!active) return;
    const m = (event as { message: any }).message;
    if (m?.role === "assistant") tallyUsage(m);
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
}
