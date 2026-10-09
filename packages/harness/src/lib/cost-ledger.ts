import {
  COST_ENTRY,
  persistedAccounts,
  mergeAccounts,
  sumAccounts,
  validReport,
  type CostAccount,
  type CostReport,
  type AccountingEntry,
} from "./cost-accounting.ts";

import { openSync, fstatSync, readSync, closeSync } from "node:fs";

export interface Usage {
  input: number;
  output: number;
  cost: number;
}

interface LedgerState {
  accounts: Map<string, CostAccount>;
  append?: (type: string, data: CostReport) => void;
  sessionId?: string;
}

const GLOBAL_KEY = "__cpiCostLedger";
const TAIL_BYTES = 16384;

function currentState(): LedgerState | undefined {
  return (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    | LedgerState
    | undefined;
}

function emptyState(): LedgerState {
  return { accounts: new Map() };
}

function record(state: LedgerState, report: CostReport): void {
  if (!validReport(report)) return;
  if (!state.append) throw new Error("cost ledger is not bound to a session");
  const next = new Map(state.accounts);
  const changes = mergeAccounts(next, report.accounts);
  if (!changes.length) return;
  sumAccounts(next.values());
  state.append(COST_ENTRY, { version: 1, accounts: changes });
  state.accounts = next;
}

export function bindCostLedger(
  entries: AccountingEntry[],
  append: (type: string, data: CostReport) => void,
  sessionId: string,
): () => void {
  const previous = currentState();
  if (previous) previous.append = undefined;
  const bound: LedgerState =
    previous?.sessionId === sessionId
      ? previous
      : { accounts: new Map(), sessionId };
  bound.accounts = persistedAccounts(entries);
  bound.append = append;
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = bound;
  return () => {
    if (bound.append === append) bound.append = undefined;
  };
}

export function captureSubagentUsageReporter(): (
  runId: string,
  usage: Usage,
) => void {
  const reportUsage = captureCostReportReporter();
  const captured = currentState();
  return (runId, usage) => {
    if (!captured?.append) return;
    if (typeof runId !== "string" || !runId.trim()) return;
    const report: CostReport = {
      version: 1,
      accounts: [{ id: `run:${runId}`, ...usage, count: 1 }],
    };
    if (!validReport(report)) return;
    reportUsage(report);
  };
}

export function captureCostReportReporter(): (report: CostReport) => void {
  const captured = currentState() ?? emptyState();
  return (report) => record(captured, report);
}

export function getSubagentUsage(): Usage & { count: number } {
  return sumAccounts((currentState() ?? emptyState()).accounts.values());
}

export function getSubagentAccounts(): CostAccount[] {
  return [...(currentState() ?? emptyState()).accounts.values()].map(
    (account) => ({ ...account }),
  );
}

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
