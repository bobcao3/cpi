import { expect, test } from "bun:test";
import { createCostSocket, sendCostReport } from "./socket.ts";
import {
  mergeAccounts,
  sumAccounts,
  type CostAccount,
  type CostReport,
} from "../lib/cost-accounting.ts";

test("real nested sockets forward cumulative descendants without counting duplicate or stale deliveries", async () => {
  const parentAccounts = new Map<string, CostAccount>();
  const childAccounts = new Map<string, CostAccount>();
  const parent = createCostSocket((r) =>
    mergeAccounts(parentAccounts, r.accounts),
  );
  const child = createCostSocket((r) =>
    mergeAccounts(childAccounts, r.accounts),
  );
  await Promise.all([parent.ready, child.ready]);
  const grandchild = (input: number, cost: number): CostReport => ({
    version: 1,
    accounts: [{ id: "run:grandchild", input, output: 7, cost, count: 1 }],
  });
  const subtree = (): CostReport => ({
    version: 1,
    accounts: [
      { id: "run:child", input: 13, output: 3, cost: 0.25, count: 1 },
      ...childAccounts.values(),
    ],
  });
  try {
    expect(await sendCostReport(child.path, grandchild(17, 0.5))).toBe(true);
    expect(await sendCostReport(parent.path, subtree())).toBe(true);
    expect(await sendCostReport(parent.path, subtree())).toBe(true);
    const stale = subtree();
    expect(await sendCostReport(child.path, grandchild(23, 0.75))).toBe(true);
    expect(await sendCostReport(parent.path, subtree())).toBe(true);
    expect(await sendCostReport(parent.path, stale)).toBe(true);
    expect(await sendCostReport(parent.path, grandchild(23, 0.75))).toBe(true);
    expect(sumAccounts(parentAccounts.values())).toEqual({
      input: 36,
      output: 10,
      cost: 1,
      count: 2,
    });
  } finally {
    child.close();
    parent.close();
  }
});
