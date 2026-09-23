import { Worker } from "node:worker_threads";

export async function runFastWorker(request) {
  const observationCredits = new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT,
  );
  const credits = new Int32Array(observationCredits);
  const worker = new Worker(
    new URL("../bin/subagent-worker.js", import.meta.url),
    {
      workerData: { ...request, observationCredits },
    },
  );
  let terminal;
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.postMessage({ kind: "abort" });
        reject(new Error("fast worker exceeded 15 seconds"));
      }, 15000);
      worker.on("message", (message) => {
        if (message.kind === "run_event") {
          Atomics.sub(credits, 0, 1);
          Atomics.notify(credits, 0);
          if (message.type === "terminal") terminal = message;
        } else if (message.kind === "candidate") {
          worker.postMessage({ kind: "finish" });
        } else if (message.kind === "done") {
          clearTimeout(timer);
          if (message.exitCode || terminal?.outcome !== "completed")
            reject(
              new Error(terminal?.error ?? `worker exit ${message.exitCode}`),
            );
          else resolve(message.exitCode);
        }
      });
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        if (code) reject(new Error(`worker exited ${code}`));
      });
    });
  } finally {
    await worker.terminate();
  }
}
