// @ts-expect-error Bun test types are runtime-provided.
import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { queueMessage, drainBeforeUser } from "./prepend-message.ts";

const coding_url = import.meta.resolve("@earendil-works/pi-coding-agent");
const coding_entry = fileURLToPath(coding_url);
const { ExtensionRunner, SessionManager } = await import(coding_entry);
const { loadExtensions } = await import(
  resolve(dirname(coding_entry), "core/extensions/loader.js")
);

queueMessage({ customType: "cwd-reminder", content: "stale one" });
queueMessage({ customType: "cwd-reminder", content: "stale two" });
queueMessage({ customType: "other", content: "keep" });
const loaded = await loadExtensions(
  [fileURLToPath(new URL("../cwd.ts", import.meta.url))],
  process.cwd(),
);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));

interface Sent {
  message: { customType: string; details?: unknown };
  options?: { deliverAs?: string; triggerTurn?: boolean };
}

let usagePercent = 0;
const sent: Sent[] = [];
const entries: Array<{ type: string; data: unknown }> = [];
const activeTools: string[] = [];
const manager = SessionManager.inMemory();
const runner = new ExtensionRunner(
  loaded.extensions,
  loaded.runtime,
  process.cwd(),
  manager,
  undefined,
);
runner.bindCore(
  {
    sendMessage: (message: Sent["message"], options: Sent["options"]) =>
      sent.push({ message, options }),
    sendUserMessage: () => {},
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    getActiveTools: () => activeTools,
    getAllTools: () => [],
    setActiveTools: (tools: string[]) => {
      activeTools.splice(0, activeTools.length, ...tools);
    },
    refreshTools: () => {},
    getCommands: () => [],
    setModel: async () => false,
    getThinkingLevel: () => "off",
    setThinkingLevel: () => {},
  } as any,
  {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => false,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => ({ percent: usagePercent }),
    compact: () => {},
    getSystemPrompt: () => "",
  } as any,
);

test("cwd extension discards reminders left in the old deferred queues", () => {
  const drained: Sent[] = [];
  drainBeforeUser({
    sendMessage: (message: Sent["message"], options: Sent["options"]) =>
      drained.push({ message, options }),
  } as any);
  expect(drained.map((item) => item.message.customType)).toEqual(["other"]);
});

test("set_cwd coalesces its reminder and delivers it at turn_end", async () => {
  sent.length = 0;
  const tool = runner.getToolDefinition("set_cwd");
  expect(tool).toBeDefined();
  const result = await tool!.execute(
    "cwd-test",
    { path: process.cwd() },
    undefined,
    undefined,
    runner.createContext(),
  );
  expect(result.isError).not.toBe(true);
  await tool!.execute(
    "cwd-test-again",
    { path: process.cwd() },
    undefined,
    undefined,
    runner.createContext(),
  );
  expect(sent).toHaveLength(0);
  await runner.emit({
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [], timestamp: Date.now() },
    toolResults: [],
  } as any);
  expect(sent).toHaveLength(1);
  expect(sent[0].message.customType).toBe("cwd-reminder");
  expect(sent[0].options).toEqual({ triggerTurn: false });
  expect(entries.at(-1)?.type).toBe("cwd-state");
});

test("context boundary reminder is delivered at turn_end without a new turn", async () => {
  sent.length = 0;
  usagePercent = 26;
  await runner.emit({
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [], timestamp: Date.now() },
    toolResults: [],
  } as any);
  expect(sent).toHaveLength(1);
  expect(sent[0].options).toEqual({ triggerTurn: false });

  await runner.emit({
    type: "turn_end",
    turnIndex: 1,
    message: { role: "assistant", content: [], timestamp: Date.now() },
    toolResults: [],
  } as any);
  expect(sent).toHaveLength(1);
});
