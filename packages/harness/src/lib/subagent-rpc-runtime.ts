import { Worker } from "node:worker_threads";
import type { Server, Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SubagentWorkerRequest } from "./subagent-rpc-protocol.ts";
import { observeSubagent, subagentEnvironment } from "./activity-subagent.ts";
import { updateActivity } from "./activity.ts";
import { SubagentObservation } from "./subagent-observation.ts";
import type { SubagentObservationOptions } from "./subagent-events.ts";
import type { SessionOwner } from "./storage/owner.ts";
import {
  reserve_owned_operation,
  type OwnedOperation,
} from "./storage/operations.ts";

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
  readonly owner: SessionOwner;
  observation: SubagentObservation;
  activityId: string;
  cancelled?: boolean;
  failed?: boolean;
  error?: Error;
  socket?: Socket;
  worker: Worker;
  done: boolean;
  exitCode: number | null;
  exited: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}
export interface RunOptions extends SubagentObservationOptions {
  onMessage?: (message: unknown) => unknown;
  operation?: OwnedOperation;
}
export interface RpcState {
  server?: Server;
  endpoint?: string;
  ready?: Promise<string>;
  owner?: SessionOwner;
  bindings: Map<string, RpcBinding>;
  retiring: Set<Promise<void>>;
  routes: Map<string, string>;
  active: Set<ActiveRun>;
}
export interface RpcBinding {
  readonly owner: SessionOwner;
  readonly endpoint: string;
  readonly server: Server;
  readonly sockets: Set<Socket>;
  readonly ready: Promise<string>;
}
export function state(): RpcState {
  const globals = globalThis as Record<string, unknown>;
  const rpc = (globals.__cpiSubagentRpc ??= { active: new Set() }) as RpcState;
  rpc.bindings ??= new Map();
  rpc.retiring ??= new Set();
  rpc.routes ??= new Map();
  return rpc;
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
  owner: SessionOwner,
  rpc: RpcState,
  endpoint: string,
  options: RunOptions,
  socket?: Socket,
): ActiveRun {
  if (rpc.active.size >= MAX_ACTIVE)
    throw new Error(`subagent concurrency limit reached (${MAX_ACTIVE})`);
  claimRunId(rpc, request);
  const operation =
    options.operation ?? reserve_owned_operation(owner, undefined, "external");
  let observation!: SubagentObservation;
  let worker: Worker;
  try {
    observation = new SubagentObservation(request, owner);
    observation.options = options;
    worker = new Worker(WORKER_PATH, {
      workerData: {
        ...request,
        storageOwner: owner,
        observationCredits: observation.credits.buffer,
      },
      env: subagentEnvironment(request, endpoint),
    });
  } catch (error) {
    try {
      observation?.finish(1, false, String(error));
    } finally {
      operation.finish();
    }
    throw error;
  }
  let resolveExit!: () => void;
  const run: ActiveRun = {
    owner,
    observation,
    activityId: request.runId,
    socket,
    worker,
    done: false,
    exitCode: null,
    exited: new Promise<void>((resolve) => {
      resolveExit = resolve;
    }),
  };
  const storage_abort = () => abortRun(run);
  operation.signal.addEventListener("abort", storage_abort, { once: true });
  if (operation.signal.aborted) storage_abort();
  let receivedDone = false;
  const fail = (error: unknown): void => {
    if (!run.failed)
      observation.options = {
        ...options,
        stdout: undefined,
        stderr: undefined,
      };
    run.failed = true;
    run.error ??= error instanceof Error ? error : new Error(String(error));
    abortRun(run);
  };
  worker.once("exit", (code) => {
    try {
      if (code !== 0 && !run.cancelled && !receivedDone)
        run.error ??= new Error(`subagent worker exited ${code}`);
      if (!receivedDone && !run.cancelled)
        run.error ??= new Error(
          "subagent worker exited without a structured done message",
        );
      finishRun(run, rpc);
    } finally {
      operation.signal.removeEventListener("abort", storage_abort);
      operation.finish();
      resolveExit();
    }
  });
  worker.on("error", fail);
  worker.on("message", (message) => {
    try {
      if (receivedDone) throw new Error("subagent worker message after done");
      if (observation.receive(message)) return;
      if (message?.kind === "done") {
        if (
          !Number.isInteger(message.exitCode) ||
          !observation.terminalReceived
        )
          throw new Error("unexpected subagent worker done message");
        receivedDone = true;
        run.exitCode = message.exitCode;
        void worker.terminate().catch(fail);
        return;
      }
      if (!options.onMessage || observation.terminalReceived)
        throw new Error("unexpected subagent worker control message");
      const response = options.onMessage(message);
      if (response !== undefined) worker.postMessage(response);
    } catch (error) {
      fail(error);
    }
  });
  rpc.active.add(run);
  try {
    observeSubagent(request, worker, owner);
    updateActivity(request.runId, {
      log_path: observation.result.markdownPath,
      metrics: {
        markdown_path: observation.result.markdownPath,
        diagnostics_path: observation.result.diagnosticsPath,
      },
    });
  } catch (error) {
    fail(error);
  }
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
