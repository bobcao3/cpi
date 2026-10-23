import { createServer, type Socket } from "node:net";
import {
  reserve_owned_operation,
  storage_owner_retired,
  type OwnedOperation,
} from "./storage/operations.ts";
import {
  MAX_ACTIVE,
  state,
  send,
  startRun,
  abortRun,
  type ActiveRun,
  type RpcState,
  type RpcBinding,
} from "./subagent-rpc-runtime.ts";
import {
  createSessionOwner,
  inheritedSessionOwner,
  sameSessionOwner,
  owner_key,
  type SessionOwner,
} from "./storage/owner.ts";
import {
  type SubagentWorkerRequest,
  validCliSubagentRequest,
  validSubagentWorkerRequest,
} from "./subagent-rpc-protocol.ts";
import {
  createSubagentRpcEndpoint,
  closeSubagentRpcListener,
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
  owner?: SessionOwner;
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
  binding: RpcBinding,
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
      binding.owner,
      rpc,
      binding.endpoint,
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

function accept(socket: Socket, rpc: RpcState, binding: RpcBinding): void {
  binding.sockets.add(socket);
  socket.once("close", () => binding.sockets.delete(socket));
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
    if (!rpc.bindings.has(binding.endpoint)) {
      fail(socket, "subagent session admission is closed");
      return;
    }
    launch(socket, value, rpc, binding);
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
  if (options.signal?.aborted) return { exitCode: null };
  const rpc = state();
  let owner: SessionOwner;
  let endpoint: string;
  let operation: OwnedOperation | undefined;
  try {
    const inherited = inheritedSessionOwner();
    const selected = options.owner ?? inherited ?? rpc.owner;
    if (!selected)
      throw new Error("subagent run requires a captured session owner");
    owner = createSessionOwner(selected.session_id, selected.session_dir);
    if (inherited && !sameSessionOwner(inherited, owner))
      throw new Error("subagent cannot change its inherited artifact owner");
    operation = reserve_owned_operation(owner, options.signal);
    options = { ...options, signal: operation.signal };
    const current = getSubagentRpc();
    endpoint =
      inherited && current
        ? current
        : rpc.owner &&
            rpc.server?.listening &&
            sameSessionOwner(rpc.owner, owner)
          ? rpc.endpoint!
          : await ensureSubagentRpc(owner);
  } catch (error) {
    operation?.finish();
    return {
      exitCode: null,
      error:
        error instanceof Error
          ? error
          : new Error("failed to start subagent RPC"),
    };
  }
  if (options.signal?.aborted) {
    operation.finish();
    return { exitCode: null };
  }

  let run: ActiveRun;
  try {
    run = startRun(request, owner, rpc, endpoint, { ...options, operation });
  } catch (error) {
    operation.finish();
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

export async function ensureSubagentRpc(owner?: SessionOwner): Promise<string> {
  const rpc = state();
  owner ??= inheritedSessionOwner() ?? rpc.owner;
  if (!owner) throw new Error("subagent RPC requires a captured session owner");
  owner = createSessionOwner(owner.session_id, owner.session_dir);
  const key = owner_key(owner);
  if (storage_owner_retired(owner)) {
    const route =
      rpc.routes.get(key) ??
      (rpc.owner && sameSessionOwner(rpc.owner, owner)
        ? rpc.endpoint
        : undefined);
    if (!route) throw new Error("retired storage owner has no RPC route");
    return route;
  }
  if (!rpc.routes.has(key) && rpc.routes.size >= 1024)
    throw new Error("subagent RPC route limit reached");
  for (const binding of rpc.bindings.values()) {
    if (sameSessionOwner(binding.owner, owner)) {
      binding.server.removeAllListeners("connection");
      binding.server.on("connection", (socket) => accept(socket, rpc, binding));
      return binding.ready;
    }
    retireBinding(binding, rpc);
  }
  if (rpc.retiring.size >= MAX_ACTIVE)
    throw new Error("subagent RPC retirement limit reached");
  const endpoint = createSubagentRpcEndpoint();
  const server = createServer();
  const binding: RpcBinding = {
    owner,
    endpoint,
    server,
    sockets: new Set(),
    ready: new Promise<string>((resolve, reject) => {
      server.on("connection", (socket) => accept(socket, rpc, binding));
      server.maxConnections = MAX_ACTIVE;
      server.once("error", reject);
      server.listen(endpoint, () => {
        server.off("error", reject);
        server.on("error", (error) => {
          process.stderr.write(`[subagent-rpc] ${error.message}\n`);
        });
        try {
          secureSubagentRpcEndpoint(endpoint);
          resolve(endpoint);
        } catch (error) {
          reject(error);
        }
      });
    }),
  };
  rpc.bindings.set(endpoint, binding);
  rpc.routes.set(key, endpoint);
  if (rpc.server && !rpc.owner) {
    const legacy = rpc.server;
    const legacyEndpoint = rpc.endpoint;
    trackClosure(
      rpc,
      closeSubagentRpcListener(
        legacy,
        legacyEndpoint,
        [...rpc.active].flatMap((run) => (run.socket ? [run.socket] : [])),
      ),
    );
  }
  rpc.owner = owner;
  rpc.server = server;
  rpc.endpoint = endpoint;
  rpc.ready = binding.ready;
  try {
    return await binding.ready;
  } catch (error) {
    rpc.bindings.delete(endpoint);
    try {
      for (const socket of binding.sockets) socket.destroy();
      await retireBinding(binding, rpc);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "subagent RPC startup cleanup failed",
      );
    } finally {
      if (rpc.ready === binding.ready) {
        rpc.ready = undefined;
        rpc.server = undefined;
        rpc.endpoint = undefined;
        rpc.owner = undefined;
      }
    }
    throw error;
  }
}

function retireBinding(
  binding: RpcBinding & { closing?: Promise<void> },
  rpc: RpcState,
): Promise<void> {
  rpc.routes.set(owner_key(binding.owner), binding.endpoint);
  rpc.bindings.delete(binding.endpoint);
  binding.closing ??= binding.ready
    .catch(() => {})
    .then(() =>
      closeSubagentRpcListener(
        binding.server,
        binding.endpoint,
        [...binding.sockets],
        new Set(
          [...rpc.active].flatMap((run) => (run.socket ? [run.socket] : [])),
        ),
      ),
    );
  trackClosure(rpc, binding.closing);
  return binding.closing;
}

function trackClosure(rpc: RpcState, closed: Promise<void>): void {
  if (rpc.retiring.has(closed)) return;
  rpc.retiring.add(closed);
  void closed.then(
    () => rpc.retiring.delete(closed),
    () => {},
  );
}

export function getSubagentRpc(): string | undefined {
  return state().endpoint ?? process.env[CPI_SUBAGENT_RPC];
}

export async function stopSubagentRpc(): Promise<void> {
  const rpc = state();
  const runs = [...rpc.active];
  const exits = runs.map((run) => run.exited);
  for (const binding of rpc.bindings.values()) retireBinding(binding, rpc);
  if (rpc.server && !rpc.owner)
    trackClosure(
      rpc,
      closeSubagentRpcListener(
        rpc.server,
        rpc.endpoint,
        runs.flatMap((run) => (run.socket ? [run.socket] : [])),
      ),
    );
  const closing = [...rpc.retiring];
  rpc.server = undefined;
  rpc.endpoint = undefined;
  rpc.ready = undefined;
  rpc.owner = undefined;
  for (const run of runs) abortRun(run);
  const settled = await Promise.allSettled([...closing, ...exits]);
  const errors = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "subagent RPC shutdown failed");
}
