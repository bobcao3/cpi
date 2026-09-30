import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { hostCodingAgent, piExecutableOnPath } from "../../bin/host-pi.mjs";
import costTree from "./index.ts";
import { createCostSocket, sendCostReport } from "./socket.ts";
import {
  captureSubagentUsageReporter,
  getSubagentUsage,
} from "../lib/cost-ledger.ts";
import {
  mergeAccounts,
  sumAccounts,
  type CostAccount,
  type CostReport,
} from "../lib/cost-accounting.ts";

if (!process.env.CPI_PI_HOST_ENTRY) {
  process.env.CPI_PI_HOST_ENTRY = piExecutableOnPath();
}
const sdk = await hostCodingAgent();
function assistant(input: number, output: number, cost: number) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "persisted accounting fixture" }],
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input,
      output,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + output,
      cost: {
        input: cost,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: cost,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
async function open(manager: any, directory: string) {
  const errors: unknown[] = [];
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [costTree],
  });
  await loader.reload();
  const { session } = await sdk.createAgentSession({
    cwd: directory,
    agentDir: directory,
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager: sdk.SettingsManager.inMemory(),
    noTools: true,
  });
  await session.bindExtensions({ onError: (e: unknown) => errors.push(e) });
  expect(errors).toEqual([]);
  return { session, errors };
}
async function shutdown(session: any) {
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "exit",
  });
  session.dispose();
}
const usage = (input: number, output: number, cost: number) => ({
  input,
  output,
  cost,
});
const child = (input: number, output: number, cost: number): CostReport => ({
  version: 1,
  accounts: [{ id: "run:child", ...usage(input, output, cost), count: 1 }],
});

test("real persisted sessions retain deduplicated subtree spend across reload, reopen, branches and forks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cpi-cost-sdk-"));
  const previous = process.env.CPI_COST_SOCKET;
  const upstream = new Map<string, CostAccount>();
  const server = createCostSocket((r) => mergeAccounts(upstream, r.accounts));
  await server.ready;
  process.env.CPI_COST_SOCKET = server.path;
  let session: any;
  try {
    const manager = sdk.SessionManager.create(directory, directory);
    const first = manager.appendMessage(assistant(11, 3, 0.125));
    manager.appendMessage(assistant(17, 5, 0.25));
    manager.branch(first);
    manager.appendMessage(assistant(23, 7, 0.5));
    ({ session } = await open(manager, directory));
    const reportUsage = captureSubagentUsageReporter();
    reportUsage("child", usage(29, 9, 1));
    const socket = process.env.CPI_COST_SOCKET!;
    expect(await sendCostReport(socket, child(29, 9, 1))).toBe(true);
    expect(getSubagentUsage()).toEqual({
      input: 29,
      output: 9,
      cost: 1,
      count: 1,
    });
    const entryCount = manager.getEntries().length;
    expect(await sendCostReport(socket, child(29, 9, 1))).toBe(true);
    expect(manager.getEntries().length).toBe(entryCount);
    expect(
      await sendCostReport(socket, {
        version: 1,
        accounts: [
          {
            id: "run:overflow",
            input: Number.MAX_SAFE_INTEGER,
            output: 0,
            cost: 0,
            count: 1,
          },
        ],
      }),
    ).toBe(false);
    expect(manager.getEntries().length).toBe(entryCount);
    await session.reload();
    expect(process.env.CPI_COST_SOCKET).toBe(socket);
    expect(getSubagentUsage()).toEqual({
      input: 29,
      output: 9,
      cost: 1,
      count: 1,
    });
    reportUsage("child", usage(31, 10, 1.5));
    expect(await sendCostReport(socket, child(31, 10, 1.5))).toBe(true);
    expect(getSubagentUsage()).toEqual({
      input: 31,
      output: 10,
      cost: 1.5,
      count: 1,
    });
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(upstream.values())).toEqual({
      input: 82,
      output: 25,
      cost: 2.375,
      count: 2,
    });
    const file = manager.getSessionFile();
    const reopened = sdk.SessionManager.open(file, directory);
    ({ session } = await open(reopened, directory));
    expect(getSubagentUsage()).toEqual({
      input: 31,
      output: 10,
      cost: 1.5,
      count: 1,
    });
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(upstream.values())).toEqual({
      input: 82,
      output: 25,
      cost: 2.375,
      count: 2,
    });
    reopened.createBranchedSession(reopened.getLeafId());
    ({ session } = await open(reopened, directory));
    reopened.appendMessage(assistant(37, 11, 2));
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(upstream.values())).toEqual({
      input: 119,
      output: 36,
      cost: 4.375,
      count: 3,
    });
    const fresh = sdk.SessionManager.create(directory, directory);
    fresh.appendMessage(assistant(41, 13, 4));
    ({ session } = await open(fresh, directory));
    expect(getSubagentUsage()).toEqual({
      input: 0,
      output: 0,
      cost: 0,
      count: 0,
    });
    reportUsage("child", usage(100, 100, 100));
    expect(getSubagentUsage()).toEqual({
      input: 0,
      output: 0,
      cost: 0,
      count: 0,
    });
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(upstream.values())).toEqual({
      input: 160,
      output: 49,
      cost: 8.375,
      count: 4,
    });
  } finally {
    if (session) await shutdown(session);
    server.close();
    if (previous) process.env.CPI_COST_SOCKET = previous;
    else delete process.env.CPI_COST_SOCKET;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker run totals share attribution with sockets and exclude resumed history", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cpi-cost-run-"));
  const previous = process.env.CPI_COST_SOCKET;
  const previousRun = process.env.CPI_COST_RUN_ID;
  const totals = new Map<string, CostAccount>();
  const server = createCostSocket((r) => mergeAccounts(totals, r.accounts));
  await server.ready;
  process.env.CPI_COST_SOCKET = server.path;
  process.env.CPI_COST_RUN_ID = "worker-run";
  let session: any;
  try {
    const manager = sdk.SessionManager.create(directory, directory);
    manager.appendMessage(assistant(101, 19, 8));
    ({ session } = await open(manager, directory));
    manager.appendMessage(assistant(43, 17, 0.25));
    await session.reload();
    manager.appendMessage(assistant(47, 23, 0.5));
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(totals.values())).toEqual({
      input: 90,
      output: 40,
      cost: 0.75,
      count: 1,
    });
    ({ session } = await open(
      sdk.SessionManager.open(manager.getSessionFile(), directory),
      directory,
    ));
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(totals.values())).toEqual({
      input: 90,
      output: 40,
      cost: 0.75,
      count: 1,
    });
    process.env.CPI_COST_RUN_ID = "worker-second";
    ({ session } = await open(
      sdk.SessionManager.open(manager.getSessionFile(), directory),
      directory,
    ));
    session.sessionManager.appendMessage(assistant(53, 29, 1));
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(totals.values())).toEqual({
      input: 143,
      output: 69,
      cost: 1.75,
      count: 2,
    });
    delete process.env.CPI_COST_RUN_ID;
    ({ session } = await open(
      sdk.SessionManager.open(manager.getSessionFile(), directory),
      directory,
    ));
    session.sessionManager.appendMessage(assistant(59, 31, 2));
    await shutdown(session);
    session = undefined;
    expect(sumAccounts(totals.values())).toEqual({
      input: 303,
      output: 119,
      cost: 11.75,
      count: 3,
    });
  } finally {
    if (session) await shutdown(session);
    server.close();
    if (previous) process.env.CPI_COST_SOCKET = previous;
    else delete process.env.CPI_COST_SOCKET;
    if (previousRun) process.env.CPI_COST_RUN_ID = previousRun;
    else delete process.env.CPI_COST_RUN_ID;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("real sockets reject oversized input and close incomplete senders on an absolute deadline", async () => {
  let accepted = 0;
  const server = createCostSocket(() => accepted++);
  await server.ready;
  const raw = (data: string) =>
    new Promise<void>((resolve) => {
      const socket = connect(server.path, () => socket.write(data));
      socket.on("error", () => {});
      socket.on("close", () => resolve());
    });
  try {
    await raw("x".repeat(1024 * 1024 + 1));
    await raw("{");
    expect(accepted).toBe(0);
    expect(await sendCostReport(server.path, child(7, 2, 0.125))).toBe(true);
    expect(accepted).toBe(1);
    expect(
      await sendCostReport(server.path, {
        input: 7,
        output: 2,
        cost: 0.125,
      } as any),
    ).toBe(false);
  } finally {
    server.close();
  }
});
