import { afterEach, expect, test } from "bun:test";
import { getEventListeners } from "node:events";
import { gate, openEventRuntime } from "./external-events-test-runtime.ts";
import { disarmAntiStuckTimer, resetAntiStuck } from "./anti-stuck.ts";
import {
  awaitHoldInterval,
  getHoldInterval,
  getLastOutcome,
  registerHoldSource,
  resetHoldTracking,
  signalHoldEvent,
  type HoldSource,
} from "./session-hold.ts";

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
let runtime: Awaited<ReturnType<typeof openEventRuntime>> | undefined;
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

afterEach(async () => {
  pending = false;
  signalHoldEvent();
  await runtime?.close();
  runtime = undefined;
  resetHoldTracking();
  disarmAntiStuckTimer();
  resetAntiStuck();
});

test("core releases a canceled session hold and does not re-hold shutdown", async () => {
  pending = true;
  aborts = 0;
  const r = (runtime = await openEventRuntime());
  r.setReplay(async () => "stop");
  const watch = r.watch();
  const first = r.session.prompt("finish");
  await watch.holding;
  const signal = r.session.agent.signal!;
  expect(r.session.isStreaming).toBe(true);
  expect(getEventListeners(signal, "abort").length).toBeGreaterThan(0);
  await r.session.abort();
  await first;
  await r.session.waitForIdle();
  expect(r.session.isStreaming).toBe(false);
  expect(r.session.agent.signal).toBeUndefined();
  expect(getLastOutcome()).toBe("aborted");
  expect(getHoldInterval()).toBe(60000);
  expect(getEventListeners(signal, "abort")).toHaveLength(0);
  expect(pending).toBe(true);
  await r.session.extensionRunner!.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  expect(aborts).toBe(1);
  await r.session.bindExtensions({ mode: "print" });
  pending = true;
  const next = r.watch("next");
  const second = r.session.prompt("finish again");
  await next.holding;
  expect(r.session.isStreaming).toBe(true);
  signalHoldEvent();
  await second;
  expect(r.session.isStreaming).toBe(false);
  expect(getLastOutcome()).toBe("completed");
  expect(r.errors).toEqual([]);
}, 10000);

test("actual core handles a pre-aborted lifecycle without acquiring a hold", async () => {
  pending = true;
  polls = 0;
  const r = (runtime = await openEventRuntime());
  const entered = gate();
  const release = gate();
  r.setReplay(async () => {
    entered.resolve();
    await release.promise;
    return "stop";
  });
  const running = r.session.prompt("finish");
  await entered.promise;
  const aborted = r.session.abort();
  release.resolve();
  await aborted;
  await running;
  expect(r.session.isStreaming).toBe(false);
  expect(getLastOutcome()).toBe("aborted");
  expect(polls).toBe(0);
  expect(r.errors).toEqual([]);
}, 10000);

test("interactive agent end preserves background ownership", async () => {
  pending = true;
  aborts = 0;
  const r = (runtime = await openEventRuntime());
  r.setReplay(async () => "stop");
  const runner = r.session.extensionRunner!;
  runner.setUIContext({ ...runner.getUIContext() }, "tui");
  await r.session.prompt("finish");
  expect(r.session.isStreaming).toBe(false);
  expect(pending).toBe(true);
  expect(aborts).toBe(0);
  expect(getLastOutcome()).toBe("completed");
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  expect(aborts).toBe(1);
  expect(r.errors).toEqual([]);
}, 10000);

test("a provider error does not acquire a hold or delay shutdown", async () => {
  pending = true;
  polls = 0;
  aborts = 0;
  const r = (runtime = await openEventRuntime());
  r.setReplay(async () => "error");
  await r.session.prompt("fail");
  expect(getLastOutcome()).toBe("error");
  expect(polls).toBe(0);
  await r.session.extensionRunner!.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  expect(aborts).toBe(1);
  expect(r.errors).toEqual([]);
}, 10000);

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
