import { Worker } from "node:worker_threads";
import type { Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentWorkerRequest } from "./subagent-rpc-protocol.ts";
import { observeSubagent, subagentEnvironment } from "./activity-subagent.ts";
import { updateActivity } from "./activity.ts";
import { SubagentObservation } from "./subagent-observation.ts";

export const MAX_ACTIVE = 16;
const MAX_RUN_ID_CHARS = 96;
const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "subagent-worker.js",
);
export interface ActiveRun {
  observation: SubagentObservation;
  activityId: string;
  cancelled?: boolean;
  failed?: boolean;
  error?: Error;
  socket?: Socket;
  worker: Worker;
  done: boolean;
  exitCode: number | null;
  timer?: ReturnType<typeof setTimeout>;
}
export interface RpcState {
  server?: Server;
  endpoint?: string;
  ready?: Promise<string>;
  active: Set<ActiveRun>;
}
export function state(): RpcState {
  const globals = globalThis as Record<string, unknown>;
  return (globals.__cpiSubagentRpc ??= { active: new Set() }) as RpcState;
}
export function send(socket: Socket, value: unknown): boolean {
  return socket.writable && socket.write(`${JSON.stringify(value)}\n`);
}
export function abortRun(run: ActiveRun): void {
  if (run.done || run.timer) return;
  run.cancelled = true;
  run.observation.resume();
  updateActivity(run.activityId, { status: "stopping" });
  try {
    run.worker.postMessage({ kind: "abort" });
  } catch {}
  run.timer = setTimeout(() => void run.worker.terminate(), 5000);
  run.timer.unref?.();
}
function claimRunId(rpc: RpcState, request: SubagentWorkerRequest): void {
  const taken = new Set([...rpc.active].map((run) => run.activityId));
  if (!taken.has(request.runId)) return;
  const base = request.runId.slice(
    0,
    MAX_RUN_ID_CHARS - String(MAX_ACTIVE + 1).length - 1,
  );
  for (let n = 2; n <= MAX_ACTIVE + 1; n++) {
    const id = `${base}-${n}`;
    if (!taken.has(id)) {
      request.runId = id;
      return;
    }
  }
  throw new Error("subagent run id space exhausted");
}
export function startRun(
  request: SubagentWorkerRequest,
  rpc: RpcState,
  endpoint: string,
  socket?: Socket,
): ActiveRun {
  if (rpc.active.size >= MAX_ACTIVE)
    throw new Error(`subagent concurrency limit reached (${MAX_ACTIVE})`);
  claimRunId(rpc, request);
  const observation = new SubagentObservation(request);
  let worker: Worker;
  try {
    worker = new Worker(WORKER_PATH, {
      workerData: {
        ...request,
        observationCredits: observation.credits.buffer,
      },
      env: subagentEnvironment(request, endpoint),
      stdout: true,
      stderr: true,
    });
  } catch (error) {
    observation.finish(1, false, String(error));
    throw error;
  }
  const run: ActiveRun = {
    observation,
    activityId: request.runId,
    socket,
    worker,
    done: false,
    exitCode: null,
  };
  rpc.active.add(run);
  observeSubagent(request, worker);
  updateActivity(request.runId, {
    log_path: observation.result.markdownPath,
    metrics: {
      markdown_path: observation.result.markdownPath,
      diagnostics_path: observation.result.diagnosticsPath,
    },
  });
  worker.stderr.on("data", (chunk: Buffer) => {
    try {
      observation.diagnostic(chunk);
    } catch (error) {
      run.failed = true;
      run.error = new Error(String(error));
      abortRun(run);
    }
  });
  return run;
}
export function finishRun(run: ActiveRun, rpc: RpcState): void {
  if (run.done) return;
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  try {
    const error = run.observation.finish(
      run.exitCode,
      !!run.cancelled,
      run.error?.message ??
        (run.failed ? "subagent worker or observation failed" : undefined),
    );
    if (error) run.error ??= error;
  } catch (error) {
    run.error ??= new Error(String(error));
  }
  if (run.error) run.exitCode = 1;
  rpc.active.delete(run);
  if (run.socket) {
    if (run.error)
      send(run.socket, {
        kind: "error",
        message: run.error.message.slice(0, 4096),
      });
    send(run.socket, {
      kind: "done",
      exitCode: Number.isInteger(run.exitCode) ? run.exitCode : 1,
    });
    run.socket.end();
  }
}
