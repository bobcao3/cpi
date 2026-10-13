import { createServer, type Socket } from "node:net";
import {
  MAX_ACTIVE,
  state,
  send,
  startRun,
  abortRun,
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
        socket.once("drain", () => {
          run.observation.resume();
        });
      }
    }
  };
  try {
    run = startRun(
      request,
      rpc,
      rpc.endpoint!,
      {
        stdout: (chunk) => forward("stdout", chunk),
        stderr: (chunk) => forward("stderr", chunk),
        onMarkdown: (chunk) => forward("stderr", Buffer.from(chunk)),
        onEvent: (event) => {
          if (event.type === "terminal" && event.answer)
            forward("stdout", Buffer.from(`${event.answer}\n`));
        },
      },
      socket,
    );
  } catch (error) {
    fail(
      socket,
      error instanceof Error
        ? error.message
        : "failed to start subagent worker",
    );
    return;
  }
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
    run = startRun(request, rpc, endpoint, options);
  } catch (error) {
    return {
      exitCode: null,
      error:
        error instanceof Error
          ? error
          : new Error("failed to start subagent worker"),
    };
  }

  const onAbort = () => abortRun(run);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) abortRun(run);
  await run.exited;
  options.signal?.removeEventListener("abort", onAbort);
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
    const server = createServer();
    server.on("connection", (socket) => accept(socket, rpc));
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
  const exits = runs.map((run) => run.exited);
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
