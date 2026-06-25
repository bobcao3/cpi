/**
 * Recursive subagent token & cost ledger.
 *
 * pi already prices every assistant message via `usage.cost.total`, using that
 * message's own model — so a subagent on a different model is model-correct for
 * free. Subagents are separate processes, so their cost crosses the process
 * boundary only via the conclusion `summary:` line (subagent-transcript ext).
 *
* Recursion model: each level reports own+descendants. This ledger collects a
* process's DIRECT children's reported subtree usage; subagent-transcript folds
* it into its own emitted `summary:` line at shutdown, and the cost-tree
* extension sends it up to the parent via the CPI_COST_SOCKET. Each child's
* reported cost already includes its own descendants and is added exactly once
* → no double counting.
*
* One feed path, via the cost-tree socket extension: each pi process listens on
* a Unix socket (CPI_COST_SOCKET, re-pointed per process); children connect at
* shutdown and send their subtree total, which the parent's listener adds here.
* Catches every spawning path uniformly (view/edit subagents, the `subagent`
* wrapper, manual `pi --print`) — no command-string gating.
 *
 * State on globalThis (shared across jiti reloads; same pattern as footer).
 * Pure leaf: node fs only. parseSummaryUsage is the single source of truth for
 * the summary-line format, shared by every parser (TS and mirrored in bash by
 * bin/subagent's own read-back).
 */

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

const GLOBAL_KEY = "__cpiCostLedger";
const TAIL_BYTES = 16384;

export interface Usage {
  input: number;
  output: number;
  cost: number;
}

interface LedgerState {
  input: number;
  output: number;
  cost: number;
  count: number;
}

function state(): LedgerState {
  const g = globalThis as Record<string, unknown>;
  const s = g[GLOBAL_KEY] as LedgerState | undefined;
  if (s) return s;
  const fresh: LedgerState = { input: 0, output: 0, cost: 0, count: 0 };
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

/** Zero the ledger. Call on session_start so a new root session (e.g. /new in
 *  the TUI) doesn't carry the prior session's subagent totals. */
export function resetSubagentUsage(): void {
  const s = state();
  s.input = 0;
  s.output = 0;
  s.cost = 0;
  s.count = 0;
}

/** Accumulate a direct child's reported subtree usage (already includes its
 *  own descendants). Tolerates partial (cost-only) reports. */
export function addSubagentUsage(u: Partial<Usage> | undefined): void {
  if (!u) return;
  const s = state();
  if (typeof u.input === "number") s.input += u.input;
  if (typeof u.output === "number") s.output += u.output;
  if (typeof u.cost === "number") s.cost += u.cost;
  s.count += 1;
}

/** Direct children's aggregated subtree usage. subagent-transcript folds this
 *  into its emitted summary so the parent receives own+descendants. */
export function getSubagentUsage(): Usage & { count: number } {
  const s = state();
  return { input: s.input, output: s.output, cost: s.cost, count: s.count };
}

// ── summary-line parsing ─────────────────────────────────────────────────────
// Format (subagent-transcript):
//   `summary: time=<s> turns=<n> in=<tok> out=<tok> cost=$<usd>`
// `cost=` is optional (older/zero reports). in/out required. The conclusion
// summary is the LAST `summary:` line in the output (emitted at shutdown), so
// matchAll + last defends against an answer that happens to quote "summary:".

const SUMMARY_RE =
  /summary:[^\n]*?\bin=(\d+)\b[^\n]*?\bout=(\d+)\b(?:[^\n]*?\bcost=\$?([0-9]+(?:\.[0-9]+)?))?/g;

/** Parse the last `summary:` line in `text`. Undefined if none. */
export function parseSummaryUsage(text: string): Usage | undefined {
  if (!text) return undefined;
  let last: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = SUMMARY_RE.exec(text)) !== null) last = m;
  if (!last) return undefined;
  return {
    input: parseInt(last[1], 10),
    output: parseInt(last[2], 10),
    cost: last[3] ? parseFloat(last[3]) : 0,
  };
}

/** Parse the last `summary:` line from the tail of a log file. Bounded read
 *  (TAIL_BYTES); the summary is the final line so the tail always holds it. */
export function parseFileSummary(path: string): Usage | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    if (len > 0) readSync(fd, buf, 0, len, Math.max(0, size - len));
    return parseSummaryUsage(buf.toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort
      }
    }
  }
}

/** Format USD for the summary line. 6 dp keeps sub-cent subagent costs distinct. */
export function formatCost(usd: number): string {
  return usd.toFixed(6);
}
