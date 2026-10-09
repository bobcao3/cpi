import { createHash } from "node:crypto";
import type { Usage } from "./cost-ledger.ts";

export const COST_ENTRY = "cpi.cost.v1";
export const COST_OWNER_ENTRY = "cpi.cost-owner.v1";
export const MAX_ACCOUNTS = 8192;
export interface CostAccount extends Usage {
  id: string;
  count: number;
}
export interface CostReport {
  version: 1;
  accounts: CostAccount[];
}
export interface AccountingEntry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  message?: {
    role: string;
    usage?: { input: number; output: number; cost: { total: number } };
  };
}
export function validAccount(value: unknown): value is CostAccount {
  const a = value as CostAccount;
  return (
    !!a &&
    typeof a.id === "string" &&
    a.id.length <= 160 &&
    /^[a-zA-Z0-9:_-]+$/.test(a.id) &&
    [a.input, a.output, a.cost].every((n) => Number.isFinite(n) && n >= 0) &&
    Number.isSafeInteger(a.input) &&
    Number.isSafeInteger(a.output) &&
    (a.count === 0 || a.count === 1)
  );
}
export function validReport(value: unknown): value is CostReport {
  const r = value as CostReport;
  return (
    !!r &&
    r.version === 1 &&
    Array.isArray(r.accounts) &&
    r.accounts.length <= MAX_ACCOUNTS &&
    r.accounts.every(validAccount)
  );
}
export function mergeAccounts(
  target: Map<string, CostAccount>,
  accounts: CostAccount[],
): CostAccount[] {
  const changes: CostAccount[] = [];
  for (const a of accounts) {
    const old = target.get(a.id);
    const next = old
      ? {
          id: a.id,
          input: Math.max(old.input, a.input),
          output: Math.max(old.output, a.output),
          cost: Math.max(old.cost, a.cost),
          count: Math.max(old.count, a.count),
        }
      : { ...a };
    if (
      old &&
      old.input === next.input &&
      old.output === next.output &&
      old.cost === next.cost &&
      old.count === next.count
    )
      continue;
    if (!old && target.size >= MAX_ACCOUNTS)
      throw new Error("cost account limit exceeded");
    target.set(a.id, next);
    changes.push(next);
  }
  return changes;
}
export function persistedAccounts(
  entries: AccountingEntry[],
): Map<string, CostAccount> {
  const accounts = new Map<string, CostAccount>();
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === COST_ENTRY &&
      validReport(entry.data)
    )
      mergeAccounts(accounts, entry.data.accounts);
  }
  return accounts;
}
export function ownAccounts(
  entries: AccountingEntry[],
  sessionId: string,
  runId?: string,
): CostAccount[] {
  const accounts = new Map<string, CostAccount>();
  let owner: string | undefined;
  let inherited = false;
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === COST_OWNER_ENTRY) {
      const data = entry.data as { id?: unknown; sessionId?: unknown } | null;
      const id = data?.id;
      inherited =
        data?.sessionId !== sessionId || (!!runId && id !== `run:${runId}`);
      owner = undefined;
      if (inherited) continue;
      if (
        typeof id === "string" &&
        (id.startsWith("run:") || id.startsWith("session:"))
      ) {
        const marker = { id, input: 0, output: 0, cost: 0, count: 1 };
        if (validAccount(marker)) {
          owner = id;
          mergeAccounts(accounts, [marker]);
        }
      }
      continue;
    }
    if (
      entry.type !== "message" ||
      entry.message?.role !== "assistant" ||
      !entry.message.usage
    )
      continue;
    if (inherited || (runId && !owner)) continue;
    const u = entry.message.usage;
    if (owner?.startsWith("run:")) {
      const old = accounts.get(owner) ?? {
        id: owner,
        input: 0,
        output: 0,
        cost: 0,
        count: 1,
      };
      const next = {
        ...old,
        input: old.input + u.input,
        output: old.output + u.output,
        cost: old.cost + u.cost.total,
      };
      if (!validAccount(next)) throw new Error("cost account overflow");
      mergeAccounts(accounts, [next]);
      continue;
    }
    const id = createHash("sha256")
      .update(
        JSON.stringify([
          entry.id,
          (entry as AccountingEntry & { timestamp?: string }).timestamp,
          entry.message,
        ]),
      )
      .digest("hex");
    const account = {
      id: `message:${id}`,
      input: u.input,
      output: u.output,
      cost: u.cost.total,
      count: 0,
    };
    if (validAccount(account)) mergeAccounts(accounts, [account]);
  }
  const marker = {
    id: runId ? `run:${runId}` : `session:${sessionId}`,
    input: 0,
    output: 0,
    cost: 0,
    count: 1,
  };
  if (validAccount(marker)) mergeAccounts(accounts, [marker]);
  return [...accounts.values()];
}
export function sumAccounts(
  accounts: Iterable<CostAccount>,
): Usage & { count: number } {
  const total = { input: 0, output: 0, cost: 0, count: 0 };
  for (const a of accounts) {
    total.input += a.input;
    total.output += a.output;
    total.cost += a.cost;
    total.count += a.count;
  }
  if (
    !Number.isSafeInteger(total.input) ||
    !Number.isSafeInteger(total.output) ||
    !Number.isFinite(total.cost)
  )
    throw new Error("cost totals overflow");
  return total;
}
