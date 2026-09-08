import { parentPort, workerData } from "node:worker_threads";

const credits =
  workerData?.observationCredits &&
  new Int32Array(workerData.observationCredits);
let sequence = 0;
let totalBytes = 0;
let finished = false;
let failure;
let answer = "";
let assistantError;
let usage = { input: 0, output: 0, cost: 0 };
let turns = 0;

/** @param {import('../extensions/lib/subagent-events.ts').SubagentEventData} data */
export function publish(data) {
  if (!parentPort || !credits)
    throw new Error("subagent observation requires root-owned worker credits");
  if (finished) throw new Error("subagent observation already finished");
  const event = {
    kind: "run_event",
    version: 1,
    runId: workerData.runId,
    sequence: sequence + 1,
    ...data,
  };
  const bytes = Buffer.byteLength(JSON.stringify(event));
  if (
    bytes > (data.type === "terminal" ? 8 : 1) * 1024 * 1024 ||
    (totalBytes + bytes > 64 * 1024 * 1024 &&
      !["usage", "terminal", "diagnostic"].includes(data.type)) ||
    sequence >=
      (data.type === "terminal"
        ? 100000
        : data.type === "usage"
          ? 99999
          : 99998)
  )
    throw new Error("subagent observation payload limit");
  while (Atomics.load(credits, 0) >= 32) {
    const pending = Atomics.load(credits, 0);
    if (pending < 32) break;
    if (Atomics.wait(credits, 0, pending, 30000) === "timed-out")
      throw new Error("subagent observation consumer stalled");
  }
  Atomics.add(credits, 0, 1);
  parentPort.postMessage(event);
  sequence++;
  totalBytes += bytes;
}

export function publishText(channel, text) {
  for (let offset = 0; offset < text.length; ) {
    let end = Math.min(text.length, offset + 8192);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    publish({ type: "text", channel, text: text.slice(offset, end) });
    offset = end;
  }
}

export function updateUsage(value, count) {
  usage = { ...value };
  turns = count;
  publish({ type: "usage", usage, turns, scope: "self" });
}

export function setFinalAnswer(text, error) {
  if (Buffer.byteLength(text) > 1024 * 1024)
    throw new Error("subagent final answer limit");
  answer = text;
  assistantError = error;
}

export function observationFailure(error) {
  failure ??= String(error).slice(0, 4096);
  process.stderr.write(`${failure}\n`);
}

export function finishObservation(exitCode, cancelled, error) {
  const reason =
    error ||
    failure ||
    (!cancelled && exitCode !== 0 ? assistantError : undefined);
  publish({ type: "usage", usage, turns, scope: "self" });
  publish({
    type: "terminal",
    outcome: reason
      ? "failed"
      : cancelled
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed",
    answer,
    ...(reason ? { error: String(reason).slice(0, 4096) } : {}),
  });
  finished = true;
  return reason ? 1 : exitCode;
}
