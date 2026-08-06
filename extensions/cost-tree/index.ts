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
    parentSocket = process.env[ENV];
    ownIn = 0;
    ownOut = 0;
    ownCost = 0;
    const { path, close: closeFn } = createCostSocket((r) => {
      addSubagentUsage(r);
      requestFooterRender();
    });
    close = closeFn;
    process.env[ENV] = path;
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
      // Awaiting this handler ensures the report is sent before exit.
      await sendCostReport(parentSocket, r);
    }
    close?.();
    close = undefined;
  });
}
