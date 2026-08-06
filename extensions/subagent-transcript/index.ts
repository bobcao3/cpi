/**
 * Print-mode transcript + run-summary streamer (active only in `pi -p`
 * subagent runs; no-op otherwise). Streams the live markdown transcript to
 * stderr — the subagent's log, which the orchestrator tails — so pi's stdout
 * stays the clean final answer. The summary goes to $PI_SUBAGENT_SUMMARY
 * (wrappers cat it after the answer), else to stderr.
 */

import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  renderToolCallMarkdown,
  shortToolCallId,
  type ToolCallBlock,
} from "../lib/transcript-registry.ts";
import { getSubagentUsage, formatCost } from "../lib/cost-ledger.ts";

const SUMMARY_PATH = process.env.PI_SUBAGENT_SUMMARY;

// Print mode is single-shot, so plain module-level state suffices.
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
      `**result** ${m.toolName ?? ""} \`${shortToolCallId(m.toolCallId, m.toolName ?? "")}\`${flag}`,
      "",
      "```",
      textOf(m.content) || "(no output)",
      "```",
      "",
    );
  }
  return out.length ? out.join("\n") + "\n" : "";
}

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
  return `jsonl: ${sessionFile}\nsummary: time=${elapsed}s turns=${turns} in=${inT} out=${outT} cost=$${formatCost(cost)}\n`;
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
    if (t !== "text_delta" && t !== "thinking_delta" && t !== "toolcall_delta")
      return;
    if (!streamed) {
      stderr(`## Assistant${asstTag}\n\n`);
      streamed = true;
    }
    const kind =
      t === "thinking_delta"
        ? "thinking"
        : t === "text_delta"
          ? "text"
          : "toolcall";
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
    // Streamed assistants already emitted their content live; emit a trailing newline so the summary stays on its own filtered line.
    if (m?.role === "assistant" && streamed) {
      stderr("\n");
      return;
    }
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
    // Land after the answer via the wrapper's temp file; fall back to stderr without one.
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
