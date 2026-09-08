// @ts-expect-error Bun test types are runtime-provided.
import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { disarmAntiStuckTimer, resetAntiStuck } from "./anti-stuck.ts";
import {
  awaitHoldInterval,
  getHoldInterval,
  getLastStopReason,
  registerHoldSource,
  resetHoldTracking,
  signalHoldEvent,
  type HoldSource,
} from "./session-hold.ts";

const coding_url = import.meta.resolve("@earendil-works/pi-coding-agent");
const coding_entry = fileURLToPath(coding_url);
const { Agent } = await import(
  import.meta.resolve("@earendil-works/pi-agent-core", coding_url)
);
const { ExtensionRunner, SessionManager } = await import(coding_entry);
const { loadExtensions } = await import(
  resolve(dirname(coding_entry), "core/extensions/loader.js")
);
const loaded = await loadExtensions(
  [fileURLToPath(new URL("../core.ts", import.meta.url))],
  process.cwd(),
);
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let pending = true;
let polls = 0;
let aborts = 0;
const source: HoldSource = {
  id: "hold-integration",
  hasPending: () => {
    polls++;
    return pending;
  },
  noticeText: () => "integration work",
  deadlineMs: 1000,
  onAbort: () => {
    aborts++;
    pending = false;
  },
};
registerHoldSource(source);

afterEach(() => {
  pending = false;
  signalHoldEvent();
  resetHoldTracking();
  disarmAntiStuckTimer();
  resetAntiStuck();
});

function lifecycle(mode = "print") {
  const agent = new Agent({
    streamFn: () => {
      throw new Error("No model calls expected");
    },
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    process.cwd(),
    SessionManager.inMemory(),
    undefined,
  );
  runner.mode = mode;
  if (mode === "tui") runner.setUIContext({ ...runner.getUIContext() }, mode);
  runner.getSignalFn = () => agent.signal;
  runner.isIdleFn = () => !agent.state.isStreaming;
  runner.onError((error: unknown) => {
    throw new Error(JSON.stringify(error));
  });
  agent.subscribe((event: { type: string }) => runner.emit(event));
  const run = (pre_aborted = false) =>
    agent.runWithLifecycle(async () => {
      await agent.processEvents({ type: "agent_start" });
      if (pre_aborted) agent.abort();
      await agent.processEvents({ type: "agent_end", messages: [] });
    });
  return { agent, runner, run };
}

test("actual core agent_end releases aborted Agent lifecycle and does not re-hold shutdown", async () => {
  pending = true;
  aborts = 0;
  const { agent, runner, run } = lifecycle();
  const first = run();
  await pause(20);
  const signal = agent.signal;
  expect(agent.state.isStreaming).toBe(true);
  expect(getEventListeners(signal, "abort").length).toBe(1);
  agent.abort();
  await first;
  await agent.waitForIdle();
  expect(agent.state.isStreaming).toBe(false);
  expect(agent.signal).toBeUndefined();
  expect(getLastStopReason()).toBe("aborted");
  expect(getHoldInterval()).toBe(60000);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(pending).toBe(true);
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  expect(aborts).toBe(1);
  pending = true;
  const second = run();
  await pause(20);
  expect(agent.state.isStreaming).toBe(true);
  signalHoldEvent();
  await second;
  expect(agent.state.isStreaming).toBe(false);
}, 2000);

test("actual core handles a pre-aborted lifecycle without acquiring a hold", async () => {
  pending = true;
  const { agent, run } = lifecycle();
  await run(true);
  expect(agent.state.isStreaming).toBe(false);
  expect(getLastStopReason()).toBe("aborted");
}, 1000);

test("interactive agent end preserves background ownership", async () => {
  pending = true;
  aborts = 0;
  const { agent, runner, run } = lifecycle("tui");
  await run();
  expect(agent.state.isStreaming).toBe(false);
  expect(pending).toBe(true);
  expect(aborts).toBe(0);
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  expect(aborts).toBe(1);
}, 1000);

for (const settlement of [
  "abort",
  "event",
  "timeout",
  "reduction",
  "pre-aborted",
  "empty",
] as const) {
  test(`hold ${settlement} cleans abort listeners and polling`, async () => {
    pending = settlement !== "empty";
    polls = 0;
    const controller = new AbortController();
    if (settlement === "pre-aborted") controller.abort();
    const wait = awaitHoldInterval(
      [source],
      settlement === "timeout" ? 1 : 1000,
      controller.signal,
    );
    if (settlement === "abort") controller.abort();
    if (settlement === "event") signalHoldEvent();
    if (settlement === "reduction") pending = false;
    expect(await wait).toBe(settlement !== "timeout");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    const settled_polls = polls;
    await pause(130);
    expect(polls).toBe(settled_polls);
    controller.abort();
    signalHoldEvent();
  }, 1000);
}
