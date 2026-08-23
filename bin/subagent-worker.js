import { parentPort, workerData } from "node:worker_threads";
import { runForkProbeSubagent } from "./fork-probe-runner.js";
import { runLlmEditorSubagent } from "./llm-editor-runner.js";
import { runSubagent } from "./subagent-runner.js";

if (!parentPort) throw new Error("subagent worker requires a parent port");

const abortController = new AbortController();
const MAX_CORRECTION_PROMPT_BYTES = 65536;
let pendingDecision;

function settleDecision(decision) {
  const resolve = pendingDecision;
  pendingDecision = undefined;
  resolve?.(decision);
}

function exchangeCandidate(candidate) {
  if (pendingDecision) {
    return Promise.reject(new Error("llm-editor decision already pending"));
  }
  if (abortController.signal.aborted) {
    return Promise.resolve({ kind: "finish" });
  }
  return new Promise((resolve) => {
    pendingDecision = resolve;
    parentPort.postMessage(candidate);
  });
}

parentPort.on("message", (message) => {
  if (message?.kind === "abort") {
    abortController.abort();
    settleDecision({ kind: "finish" });
    return;
  }
  if (workerData?.kind !== "llm-editor" || !pendingDecision) return;
  if (message?.kind === "finish") {
    settleDecision(message);
    return;
  }
  if (
    message?.kind === "continue" &&
    typeof message.prompt === "string" &&
    message.prompt.length > 0 &&
    !message.prompt.includes("\0") &&
    Buffer.byteLength(message.prompt, "utf8") <= MAX_CORRECTION_PROMPT_BYTES
  ) {
    settleDecision(message);
    return;
  }
  process.stderr.write("invalid llm-editor worker decision\n");
  abortController.abort();
  settleDecision({ kind: "finish" });
});

let exitCode = 1;
try {
  if (!workerData || typeof workerData !== "object") {
    throw new Error("unsupported subagent worker request");
  }
  if (workerData.kind === "llm-editor") {
    exitCode = await runLlmEditorSubagent(
      workerData,
      abortController.signal,
      exchangeCandidate,
    );
  } else if (workerData.kind === "fork-probe") {
    exitCode = await runForkProbeSubagent(workerData, abortController.signal);
  } else if (workerData.kind === undefined) {
    exitCode = await runSubagent(workerData, abortController.signal);
  } else {
    throw new Error("unsupported subagent worker request");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
}
parentPort.postMessage({ kind: "done", exitCode });
parentPort.close();
