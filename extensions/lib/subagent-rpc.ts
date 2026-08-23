import { Worker } from "node:worker_threads";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type SubagentWorkerRequest,
  validCliSubagentRequest,
  validSubagentWorkerRequest,
} from "./subagent-rpc-protocol.ts";
import {
  createSubagentRpcEndpoint,
  removeSubagentRpcEndpoint,
  secureSubagentRpcEndpoint,
} from "./subagent-rpc-endpoint.ts";

export type {
  ForkProbeSubagentRequest,
  LlmEditorCandidate,
  LlmEditorSubagentRequest,
} from "./subagent-rpc-protocol.ts";

export const CPI_SUBAGENT_RPC = "CPI_SUBAGENT_RPC";
const STATE_KEY = "__cpiSubagentRpc";
const MAX_ACTIVE = 16;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const ABORT_GRACE_MS = 5000;
const MAX_FORWARDED_DATA_CHUNK_BYTES = 48 * 1024;
const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "subagent-worker.js",
);

export interface SubagentWorkerRunOptions {
  signal?: AbortSignal;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  onMessage?: (message: unknown) => unknown;
}

export interface SubagentWorkerRunResult {
  exitCode: number | null;
  error?: Error;
}

interface ActiveRun {
  socket?: Socket;
  worker: Worker;
  done: boolean;
  exitCode: number | null;
  timer?: ReturnType<typeof setTimeout>;
}

interface RpcState {
  server?: Server;
  endpoint?: string;
  ready?: Promise<string>;
  active: Set<ActiveRun>;
}

function state(): RpcState {
  const g = globalThis as Record<string, unknown>;
  let value = g[STATE_KEY] as RpcState | undefined;
  if (!value) {
    value = { active: new Set() };
    g[STATE_KEY] = value;
  }
  return value;
}

function send(socket: Socket, value: unknown): boolean {
  if (!socket.writable) return false;
  return socket.write(`${JSON.stringify(value)}\n`);
}

function fail(socket: Socket, message: string): void {
  send(socket, { kind: "error", message: message.slice(0, 4096) });
  send(socket, { kind: "done", exitCode: 1 });
  socket.end();
}

function abortRun(run: ActiveRun): void {
  if (run.done || run.timer) return;
  try {
    run.worker.postMessage({ kind: "abort" });
  } catch {}
  run.timer = setTimeout(() => void run.worker.terminate(), ABORT_GRACE_MS);
  run.timer.unref?.();
}

function workerEnvironment(request: SubagentWorkerRequest, endpoint: string) {
  const env: Record<string, string> = {
    ...request.env,
    [CPI_SUBAGENT_RPC]: endpoint,
    PI_SUBAGENT: "1",
  };
  if ("kind" in request && request.kind === "llm-editor") {
    env.PI_SUBAGENT_ROLE = request.role;
    env.PI_SUBAGENT_CWD = request.cwd;
    if (request.outputMode === "tool-call")
      env.PI_SUBAGENT_COMPLETION = request.completionPath!;
  }
  if ("kind" in request && request.kind === "fork-probe") {
    env.CPI_FORK_PROBE = "1";
    env.PI_SESSION_ID = request.parentSessionId;
    env.PI_SESSION = request.parentSessionId.slice(0, 8);
    env.PI_SESSION_DIR = request.sessionDir;
    delete env.PI_SUBAGENT_COMPLETION;
    delete env.PI_SUBAGENT_ROLE;
    delete env.PI_SUBAGENT_CWD;
    delete env.PI_SUBAGENT_SUMMARY;
  }
  return env;
}

function startRun(
  request: SubagentWorkerRequest,
  rpc: RpcState,
  endpoint: string,
  socket?: Socket,
): ActiveRun {
  if (rpc.active.size >= MAX_ACTIVE) {
    throw new Error(`subagent concurrency limit reached (${MAX_ACTIVE})`);
  }
  const worker = new Worker(WORKER_PATH, {
    workerData: request,
    env: workerEnvironment(request, endpoint),
    stdout: true,
    stderr: true,
  });
  const run: ActiveRun = { socket, worker, done: false, exitCode: null };
  rpc.active.add(run);
  return run;
}

function finishRun(run: ActiveRun, rpc: RpcState): void {
  if (run.done) return;
  run.done = true;
  if (run.timer) clearTimeout(run.timer);
  rpc.active.delete(run);
  if (run.socket) {
    send(run.socket, {
      kind: "done",
      exitCode: Number.isInteger(run.exitCode) ? run.exitCode : 1,
    });
    run.socket.end();
  }
}

function launch(
  socket: Socket,
  request: SubagentWorkerRequest,
  rpc: RpcState,
): void {
  let run: ActiveRun;
  try {
    run = startRun(request, rpc, rpc.endpoint!, socket);
  } catch (error) {
    fail(
      socket,
      error instanceof Error
        ? error.message
        : "failed to start subagent worker",
    );
    return;
  }
  const { worker } = run;
  const forward = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    for (
      let offset = 0;
      offset < chunk.length;
      offset += MAX_FORWARDED_DATA_CHUNK_BYTES
    ) {
      const writable = send(socket, {
        kind: "data",
        stream,
        data: chunk
          .subarray(offset, offset + MAX_FORWARDED_DATA_CHUNK_BYTES)
          .toString("base64"),
      });
      if (!writable) {
        worker.stdout.pause();
        worker.stderr.pause();
        socket.once("drain", () => {
          worker.stdout.resume();
          worker.stderr.resume();
        });
      }
    }
  };
  worker.stdout.on("data", (chunk: Buffer) => forward("stdout", chunk));
  worker.stderr.on("data", (chunk: Buffer) => forward("stderr", chunk));
  worker.on("message", (message) => {
    if (message?.kind === "done" && Number.isInteger(message.exitCode)) {
      run.exitCode = message.exitCode;
    }
  });
  worker.on("error", (error) => {
    send(socket, { kind: "error", message: error.message.slice(0, 4096) });
    run.exitCode = 1;
  });
  worker.on("exit", () => {
    finishRun(run, rpc);
  });
  socket.on("close", () => abortRun(run));
  socket.on("error", () => abortRun(run));
}

function accept(socket: Socket, rpc: RpcState): void {
  let input = Buffer.alloc(0);
  const onData = (chunk: Buffer): void => {
    if (input.length + chunk.length > MAX_REQUEST_BYTES) {
      socket.off("data", onData);
      fail(socket, "subagent RPC request too large");
      return;
    }
    input = Buffer.concat([input, chunk]);
    const newline = input.indexOf(0x0a);
    if (newline < 0) return;
    socket.off("data", onData);
    let value: unknown;
    try {
      value = JSON.parse(input.subarray(0, newline).toString("utf8"));
    } catch {
      fail(socket, "malformed subagent RPC request");
      return;
    }
    if (!validCliSubagentRequest(value)) {
      fail(socket, "invalid subagent RPC request");
      return;
    }
    launch(socket, value, rpc);
  };
  socket.on("data", onData);
  socket.on("error", () => {});
}

export async function runSubagentWorker(
  request: SubagentWorkerRequest,
  options: SubagentWorkerRunOptions = {},
): Promise<SubagentWorkerRunResult> {
  if (!validSubagentWorkerRequest(request)) {
    return {
      exitCode: null,
      error: new Error("invalid subagent worker request"),
    };
  }
  let endpoint = getSubagentRpc();
  try {
    endpoint ??= await ensureSubagentRpc();
  } catch (error) {
    return {
      exitCode: null,
      error:
        error instanceof Error
          ? error
          : new Error("failed to start subagent RPC"),
    };
  }
  const rpc = state();
  if (options.signal?.aborted) return { exitCode: null };

  let run: ActiveRun;
  try {
    run = startRun(request, rpc, endpoint);
  } catch (error) {
    return {
      exitCode: null,
      error:
        error instanceof Error
          ? error
          : new Error("failed to start subagent worker"),
    };
  }

  let error: Error | undefined;
  let receivedDone = false;
  const fail = (value: unknown): void => {
    if (!error)
      error =
        value instanceof Error ? value : new Error("subagent worker failed");
    abortRun(run);
  };
  const forward = (
    callback: ((chunk: Buffer) => void) | undefined,
    chunk: Buffer,
  ) => {
    if (!callback || error) return;
    try {
      callback(chunk);
    } catch (value) {
      fail(value);
    }
  };
  const onAbort = () => abortRun(run);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) abortRun(run);

  run.worker.stdout.on("data", (chunk: Buffer) =>
    forward(options.stdout, chunk),
  );
  run.worker.stderr.on("data", (chunk: Buffer) =>
    forward(options.stderr, chunk),
  );
  run.worker.on("message", (message) => {
    if (message?.kind === "done") {
      if (receivedDone) {
        fail(
          new Error("subagent worker sent multiple structured done messages"),
        );
        return;
      }
      if (!Number.isInteger(message.exitCode)) {
        fail(new Error("unexpected subagent worker message"));
        return;
      }
      receivedDone = true;
      run.exitCode = message.exitCode;
      return;
    }
    if (!options.onMessage) {
      fail(new Error("unexpected subagent worker message"));
      return;
    }
    let response: unknown;
    try {
      response = options.onMessage(message);
    } catch (value) {
      fail(value);
      return;
    }
    if (response !== undefined) {
      try {
        run.worker.postMessage(response);
      } catch (value) {
        fail(value);
      }
    }
  });
  run.worker.on("error", (value) => fail(value));
  await new Promise<void>((resolve) => run.worker.once("exit", resolve));
  finishRun(run, rpc);
  options.signal?.removeEventListener("abort", onAbort);
  if (!receivedDone && !error && !options.signal?.aborted)
    error = new Error(
      "subagent worker exited without a structured done message",
    );
  return { exitCode: options.signal?.aborted ? null : run.exitCode, error };
}

export async function ensureSubagentRpc(): Promise<string> {
  const rpc = state();
  if (rpc.endpoint && rpc.server?.listening) return rpc.endpoint;
  if (rpc.ready) return rpc.ready;
  rpc.ready = new Promise<string>((resolve, reject) => {
    const endpoint = createSubagentRpcEndpoint();
    const server = createServer((socket) => accept(socket, rpc));
    server.maxConnections = MAX_ACTIVE;
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      secureSubagentRpcEndpoint(endpoint);
      rpc.server = server;
      rpc.endpoint = endpoint;
      resolve(endpoint);
    });
  });
  try {
    return await rpc.ready;
  } catch (error) {
    rpc.ready = undefined;
    throw error;
  }
}

export function getSubagentRpc(): string | undefined {
  return state().endpoint ?? process.env[CPI_SUBAGENT_RPC];
}

export async function stopSubagentRpc(): Promise<void> {
  const rpc = state();
  const runs = [...rpc.active];
  const exits = runs
    .filter((run) => !run.done)
    .map(
      (run) => new Promise<void>((resolve) => run.worker.once("exit", resolve)),
    );
  const server = rpc.server;
  const endpoint = rpc.endpoint;
  rpc.server = undefined;
  rpc.endpoint = undefined;
  rpc.ready = undefined;
  const serverClosed = server
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve();
  for (const run of runs) abortRun(run);
  await Promise.all([serverClosed, ...exits]);
  if (endpoint) removeSubagentRpcEndpoint(endpoint);
}
