/**
 * Print-mode transcript + run-summary streamer (active only in `pi -p`
 * subagent runs; no-op otherwise). Streams the live markdown transcript to
 * stderr — the subagent's log, which the orchestrator tails — so pi's stdout
 * stays the clean final answer. The summary goes to $PI_SUBAGENT_SUMMARY
 * (wrappers cat it after the answer), else to stderr.
 */

import { writeFileSync } from "node:fs";
import { isMainThread } from "node:worker_threads";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  renderToolCallMarkdown,
  truncate,
  type ToolCallBlock,
} from "../lib/transcript-registry.ts";
import { getSubagentUsage, formatCost } from "../lib/cost-ledger.ts";

const SUMMARY_PATH = process.env.PI_SUBAGENT_SUMMARY;

// Each isolated worker owns one session, so module-level state suffices.
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

// Whitespace discipline: right-trim lines, cap blank runs at one blank line,
// never start the stream with blank lines. Deltas arrive mid-line, so lines
// are completed through a buffer.
let lineBuf = "";
let blankRun = 0;
let wroteLine = false;

function commitLine(line: string): void {
  if (!line.trim()) {
    if (wroteLine) blankRun = 1;
    return;
  }
  if (wroteLine) stderr("\n".repeat(blankRun));
  stderr(line.replace(/\s+$/, "") + "\n");
  wroteLine = true;
  blankRun = 0;
}

function write(chunk: string): void {
  lineBuf += chunk;
  for (;;) {
    const idx = lineBuf.indexOf("\n");
    if (idx === -1) break;
    commitLine(lineBuf.slice(0, idx));
    lineBuf = lineBuf.slice(idx + 1);
  }
}

function flushWrite(): void {
  if (lineBuf) commitLine(lineBuf);
  lineBuf = "";
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c?.type === "text" && c.text)
    .map((c) => c.text)
    .join("\n");
}

const RESULT_PREVIEW_LINES = 10;
const MAX_RESULT_LINE_CHARS = 200;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

function resultText(m: any): string {
  const parts: string[] = [];
  for (const c of Array.isArray(m.content) ? m.content : []) {
    if (c?.type === "text" && c.text) parts.push(c.text);
    else if (c?.type === "image")
      parts.push(`[image ${c.mimeType ?? "unknown"}]`);
  }
  return parts.join("\n").replace(/\r/g, "").replace(ANSI_RE, "");
}

// TUI-style preview: blockquoted tool output, capped like the interactive fallback.
function renderResultQuote(m: any): string[] {
  const text = resultText(m);
  if (!text.trim()) return [];
  const lines = text.split("\n").map((l) => truncate(l, MAX_RESULT_LINE_CHARS));
  const quote = lines
    .slice(0, RESULT_PREVIEW_LINES)
    .map((l) => (l ? `> ${l}` : ">"));
  const rest = lines.length - quote.length;
  if (rest > 0) quote.push(`> … (${rest} more lines)`);
  if (m.isError) quote[0] = `> [error] ${quote[0].slice(2)}`;
  return [...quote, ""];
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
    out.push(...renderResultQuote(m));
  }
  return out.length ? out.join("\n") + "\n" : "";
}

function ensureAssistantHeader(): void {
  if (streamed) return;
  write(`## Assistant${asstTag}\n\n`);
  streamed = true;
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
  if (!isMainThread && process.env.CPI_ACTIVITY_TELEMETRY === "1") return;
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
    lineBuf = "";
    blankRun = 0;
    wroteLine = false;
    asstTag = "";
    write(`jsonl: ${sessionFile}\n`);
  });

  pi.on("turn_end", async (_event) => {
    if (active) turns += 1;
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
    if (t === "toolcall_end") {
      ensureAssistantHeader();
      if (lastKind === "thinking") write("\n\n");
      lastKind = "toolcall";
      for (const line of renderToolCallMarkdown(ev.toolCall as ToolCallBlock))
        write(line + "\n");
      return;
    }
    if (t !== "text_delta" && t !== "thinking_delta") return;
    ensureAssistantHeader();
    const kind = t === "thinking_delta" ? "thinking" : "text";
    if (kind !== lastKind) {
      if (kind === "thinking") write("## Thinking\n\n");
      else if (lastKind === "thinking") write("\n\n");
      lastKind = kind;
    }
    const d = typeof ev.delta === "string" ? ev.delta : "";
    if (d) write(d);
  });

  pi.on("message_end", async (event) => {
    if (!active) return;
    const m = (event as { message: any }).message;
    if (m?.role === "assistant") tallyUsage(m);
    // Streamed assistants already emitted their content live; the writer flushes any partial line so the summary starts on its own line.
    if (m?.role === "assistant" && streamed) {
      flushWrite();
      return;
    }
    let md = "";
    try {
      md = renderMessage(m);
    } catch {
      md = "";
    }
    write(md);
  });

  pi.on("session_shutdown", async () => {
    if (!active) return;
    flushWrite();
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
    write(summary);
  });
}
