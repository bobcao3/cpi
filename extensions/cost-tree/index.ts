/**
 * cost-tree: recursive cost roll-up across the pi process tree via a
 * per-process Unix socket (see ./socket.ts).
 *
 * Loaded by every pi process: auto-loaded in the main (extensions/ dir);
 * `-e`'d into llm-editor subagents by subagent.ts (which runs --no-extensions);
 * auto-loaded into `subagent`-wrapper children (that wrapper does not use
 * --no-extensions).
 *
 *   session_start  : save inherited CPI_COST_SOCKET (parent's; undefined at the
 *                    root), create own socket, re-point CPI_COST_SOCKET to own
 *                    so children report here, listen.
 *   message_end    : tally own usage (this node's leaf cost).
 *   session_shutdown: send subtree total (own + aggregated descendants) to the
 *                    parent socket, then close+unlink own. The root (no parent
 *                    socket) only listens.
 *
 * Each node reports its subtree ONCE to its immediate parent; grandchildren
 * report to the child (whose env they inherited), never the root → no double
 * counting. Replaces shell/cost-feed.ts (regex-gated) and llm-editor's direct
 * addSubagentUsage calls: one mechanism, deterministic, no command guessing.
 *
 * Leaf: ./socket.ts + lib/cost-ledger + lib/footer.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCostSocket, sendCostReport, type CostReport } from "./socket.ts";
import { addSubagentUsage, getSubagentUsage } from "../lib/cost-ledger.ts";
import { requestFooterRender } from "../lib/footer.ts";

const ENV = "CPI_COST_SOCKET";

let parentSocket: string | undefined;
let close: (() => void) | undefined;
let ownIn = 0;
let ownOut = 0;
let ownCost = 0;

export default async function costTree(pi: ExtensionAPI): Promise<void> {
  pi.on("session_start", async () => {
    parentSocket = process.env[ENV]; // inherited (parent's); undefined at the root
    ownIn = 0;
    ownOut = 0;
    ownCost = 0;
    const { path, close: closeFn } = createCostSocket((r) => {
      addSubagentUsage(r);
      requestFooterRender();
    });
    close = closeFn;
    process.env[ENV] = path; // re-point so children report to THIS process
  });

  pi.on("message_end", async (event: any) => {
    const m = event?.message;
    if (!m || m.role !== "assistant") return;
    const u = m?.usage;
    if (!u) return;
    if (typeof u.input === "number") ownIn += u.input;
    if (typeof u.output === "number") ownOut += u.output;
    if (typeof u.cost?.total === "number") ownCost += u.cost.total;
  });

  pi.on("session_shutdown", async () => {
    if (parentSocket) {
      const sub = getSubagentUsage();
      const r: CostReport = {
        input: ownIn + sub.input,
        output: ownOut + sub.output,
        cost: ownCost + sub.cost,
      };
      // pi awaits session_shutdown handlers, so the send completes before exit.
      await sendCostReport(parentSocket, r);
    }
    close?.();
    close = undefined;
  });
}
