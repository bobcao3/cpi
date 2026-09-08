import { createServer, type Socket } from "node:net";
import {
  MAX_ACTIVE,
  state,
  send,
  startRun,
  abortRun,
  finishRun,
  type ActiveRun,
  type RpcState,
} from "./subagent-rpc-runtime.ts";
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
import type {
  SubagentObservationOptions,
  SubagentObservationResult,
} from "./subagent-events.ts";

export type {
  ForkProbeSubagentRequest,
  SubagentCandidate,
  SessionSubagentRequest,
} from "./subagent-rpc-protocol.ts";

export const CPI_SUBAGENT_RPC = "CPI_SUBAGENT_RPC";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_FORWARDED_DATA_CHUNK_BYTES = 48 * 1024;
const MAX_SOCKET_BACKLOG_BYTES = 8 * 1024 * 1024;

export interface SubagentWorkerRunOptions extends SubagentObservationOptions {
  signal?: AbortSignal;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
  onMessage?: (message: unknown) => unknown;
}

export interface SubagentWorkerRunResult {
  exitCode: number | null;
  error?: Error;
  observation?: SubagentObservationResult;
}

function fail(socket: Socket, message: string): void {
  send(socket, { kind: "error", message: message.slice(0, 4096) });
  send(socket, { kind: "done", exitCode: 1 });
  socket.end();
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
    if (!socket.writable) return;
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
      if (socket.writableLength > MAX_SOCKET_BACKLOG_BYTES) {
        run.error = new Error("subagent RPC output backlog limit");
        abortRun(run);
        socket.destroy();
        return;
      }
      if (!writable && !run.observation.paused) {
        run.observation.paused = true;
        worker.stdout.pause();
        worker.stderr.pause();
        socket.once("drain", () => {
          run.observation.resume();
          worker.stdout.resume();
          worker.stderr.resume();
        });
      }
    }
  };
  worker.stdout.on("data", (chunk: Buffer) => forward("stdout", chunk));
  worker.stderr.on("data", (chunk: Buffer) => forward("stderr", chunk));
  run.observation.options = {
    onMarkdown: (chunk) => forward("stderr", Buffer.from(chunk)),
    onEvent: (event) => {
      if (event.type === "terminal" && event.answer)
        forward("stdout", Buffer.from(`${event.answer}\n`));
    },
  };
  worker.on("message", (message) => {
    try {
      if (run.observation.receive(message)) return;
    } catch (error) {
      run.failed = true;
      run.error = new Error(String(error));
      send(socket, { kind: "error", message: String(error) });
      abortRun(run);
      return;
    }
    if (
      message?.kind === "done" &&
      Number.isInteger(message.exitCode) &&
      run.exitCode === null
    ) {
      run.exitCode = message.exitCode;
    } else {
      run.error = new Error("unexpected subagent worker control message");
      abortRun(run);
    }
  });
  worker.on("error", (error) => {
    run.failed = true;
    run.error = error;
    send(socket, {
      kind: "error",
      message: (error instanceof Error ? error.message : String(error)).slice(
        0,
        4096,
      ),
    });
    run.exitCode = 1;
  });
  worker.on("exit", (code) => {
    if (code !== 0 && !run.cancelled)
      run.error ??= new Error(`subagent worker exited ${code}`);
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
  run.observation.options = options;
  let receivedDone = false;
  const fail = (value: unknown): void => {
    run.failed = true;
    if (!error)
      error =
        value instanceof Error ? value : new Error("subagent worker failed");
    run.error = error;
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
    try {
      if (run.observation.receive(message)) return;
    } catch (value) {
      fail(value);
      return;
    }
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
  const workerExit = await new Promise<number>((resolve) =>
    run.worker.once("exit", resolve),
  );
  if (workerExit !== 0 && !run.cancelled)
    error ??= new Error(`subagent worker exited ${workerExit}`);
  options.signal?.removeEventListener("abort", onAbort);
  if (!receivedDone && !error && !options.signal?.aborted)
    error = new Error(
      "subagent worker exited without a structured done message",
    );
  if (error) run.failed = true;
  run.error ??= error;
  finishRun(run, rpc);
  return {
    exitCode: options.signal?.aborted ? null : run.exitCode,
    error: run.error,
    observation: run.observation.result,
  };
}

export async function ensureSubagentRpc(): Promise<string> {
  const rpc = state();
  if (rpc.endpoint && rpc.server?.listening) {
    rpc.server.removeAllListeners("connection");
    rpc.server.on("connection", (socket) => accept(socket, rpc));
    return rpc.endpoint;
  }
  if (rpc.ready) return rpc.ready;
  rpc.ready = new Promise<string>((resolve, reject) => {
    const endpoint = createSubagentRpcEndpoint();
    const server = createServer((socket) => accept(socket, rpc));
    server.maxConnections = MAX_ACTIVE;
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      server.on("error", (error) => {
        process.stderr.write(`[subagent-rpc] ${error.message}\n`);
      });
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
