import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { createCostSocket, sendCostReport } from "./socket.ts";
import {
  captureCostReportReporter,
  bindCostLedger,
  getSubagentAccounts,
} from "../lib/cost-ledger.ts";
import {
  mergeAccounts,
  ownAccounts,
  COST_OWNER_ENTRY,
  type CostReport,
} from "../lib/cost-accounting.ts";
import { requestFooterRender } from "../lib/footer.ts";

const ENV = "CPI_COST_SOCKET";
const RESOURCE_KEY = "__cpiCostSocketOwner";
interface Resource {
  path: string;
  sessionId: string;
  parent?: string;
  close: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
}

export default function costTree(pi: ExtensionAPI): void {
  const global = globalThis as Record<string, unknown>;
  let resource: Resource | undefined;
  let context: ExtensionContext | undefined;
  let unbind: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let runId: string | undefined;
  let lastSent = "";
  let pending: Promise<boolean> | undefined;
  const report = (): CostReport => {
    const accounts = new Map();
    mergeAccounts(accounts, getSubagentAccounts());
    mergeAccounts(
      accounts,
      ownAccounts(
        context!.sessionManager.getEntries(),
        context!.sessionManager.getSessionId(),
        runId,
      ),
    );
    return { version: 1, accounts: [...accounts.values()] };
  };
  const flush = async (): Promise<void> => {
    if (!resource?.parent || pending) return;
    const snapshot = report();
    const wire = JSON.stringify(snapshot);
    if (wire === lastSent) return;
    pending = sendCostReport(resource.parent, snapshot);
    try {
      if (await pending) lastSent = wire;
    } finally {
      pending = undefined;
    }
  };
  pi.on("session_start", async (event, ctx) => {
    const previous = global[RESOURCE_KEY] as Resource | undefined;
    const reuse =
      event.reason === "reload" &&
      previous?.sessionId === ctx.sessionManager.getSessionId();
    const parent =
      previous && process.env[ENV] === previous.path
        ? previous.parent
        : process.env[ENV];
    clearInterval(previous?.timer);
    if (!reuse) await previous?.close();
    unbind?.();
    context = ctx;
    lastSent = "";
    const entries = ctx.sessionManager.getEntries();
    unbind = bindCostLedger(
      entries,
      (type, data) => pi.appendEntry(type, data),
      ctx.sessionManager.getSessionId(),
    );
    runId = process.env.CPI_COST_RUN_ID;
    if (runId && !/^[a-zA-Z0-9-]{1,96}$/.test(runId))
      throw new Error("invalid cost run ID");
    const id = runId
      ? `run:${runId}`
      : `session:${ctx.sessionManager.getSessionId()}`;
    const saved = entries
      .filter((e) => e.type === "custom" && e.customType === COST_OWNER_ENTRY)
      .at(-1);
    if ((saved as { data?: { id?: string } })?.data?.id !== id)
      pi.appendEntry(COST_OWNER_ENTRY, {
        id,
        sessionId: ctx.sessionManager.getSessionId(),
      });
    if (reuse) resource = previous;
    else {
      const recordReport = captureCostReportReporter();
      let socket: ReturnType<typeof createCostSocket> | undefined;
      try {
        socket = createCostSocket((r) => {
          recordReport(r);
          requestFooterRender();
        });
        await socket.ready;
      } catch (error) {
        try {
          await socket?.close();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "cost socket startup cleanup failed",
          );
        } finally {
          unbind?.();
        }
        throw error;
      }
      resource = {
        path: socket.path,
        sessionId: ctx.sessionManager.getSessionId(),
        parent,
        close: socket.close,
      };
    }
    global[RESOURCE_KEY] = resource;
    process.env[ENV] = resource.path;
    timer = setInterval(() => {
      void flush().catch(() => {});
    }, 1000);
    timer.unref();
    resource.timer = timer;
  });
  pi.on("agent_end", flush);
  pi.on("session_shutdown", async (event) => {
    clearInterval(timer);
    let failed = false;
    let failure: unknown;
    try {
      await pending;
      await flush();
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        if (event.reason !== "reload") await resource?.close();
      } catch (error) {
        if (failed)
          throw new AggregateError(
            [failure, error],
            "cost socket shutdown cleanup failed",
          );
        throw error;
      } finally {
        if (
          event.reason !== "reload" &&
          resource &&
          process.env[ENV] === resource.path
        ) {
          if (resource.parent) process.env[ENV] = resource.parent;
          else delete process.env[ENV];
        }
        if (event.reason !== "reload" && global[RESOURCE_KEY] === resource)
          delete global[RESOURCE_KEY];
        unbind?.();
        resource = undefined;
        context = undefined;
      }
    }
    if (failed) throw failure;
  });
}
