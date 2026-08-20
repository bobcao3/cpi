import { parentPort, workerData } from "node:worker_threads";
import { runSubagent } from "./subagent-runner.js";

if (!parentPort) throw new Error("subagent worker requires a parent port");

const abortController = new AbortController();
parentPort.on("message", (message) => {
  if (message?.kind === "abort") abortController.abort();
});

let exitCode = 1;
try {
  exitCode = await runSubagent(workerData, abortController.signal);
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
}
parentPort.postMessage({ kind: "done", exitCode });
parentPort.close();
