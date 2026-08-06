/**
 * Subagent cost ledger: children report their subtree totals at shutdown via
 * CPI_COST_SOCKET, crossing the process boundary through the `summary:` line,
 * each added exactly once — no double counting.
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

export function resetSubagentUsage(): void {
  const s = state();
  s.input = 0;
  s.output = 0;
  s.cost = 0;
  s.count = 0;
}

export function addSubagentUsage(u: Partial<Usage> | undefined): void {
  if (!u) return;
  const s = state();
  if (typeof u.input === "number") s.input += u.input;
  if (typeof u.output === "number") s.output += u.output;
  if (typeof u.cost === "number") s.cost += u.cost;
  s.count += 1;
}

export function getSubagentUsage(): Usage & { count: number } {
  const s = state();
  return { input: s.input, output: s.output, cost: s.cost, count: s.count };
}

// `summary:` line: in/out required, `cost=` optional; the LAST line wins, so tail reads hold it.

const SUMMARY_RE =
  /summary:[^\n]*?\bin=(\d+)\b[^\n]*?\bout=(\d+)\b(?:[^\n]*?\bcost=\$?([0-9]+(?:\.[0-9]+)?))?/g;

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
      } catch {}
    }
  }
}

export function formatCost(usd: number): string {
  return usd.toFixed(6);
}
