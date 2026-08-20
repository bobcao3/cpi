import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeDir } from "../../tools/sh-monitor/runtime-dir.ts";

export const CPI_SUBAGENT_RPC = "CPI_SUBAGENT_RPC";
const STATE_KEY = "__cpiSubagentRpc";
const MAX_ACTIVE = 16;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_TASK_BYTES = 1024 * 1024;
const MAX_ARGV = 64;
const ABORT_GRACE_MS = 5000;
const MAX_UNIX_SOCKET_PATH_BYTES = 100;
const MAX_FORWARDED_DATA_CHUNK_BYTES = 48 * 1024;
const WORKER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "bin",
  "subagent-worker.js",
);

interface Request {
  version: 1;
  argv: string[];
  task: string;
  cwd: string;
  env: Record<string, string>;
  runId: string;
}

interface ActiveRun {
  socket: Socket;
  worker: Worker;
  done: boolean;
  exitCode: number;
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

function privateShortRuntimeDir(): string {
  const uid = process.getuid?.();
  if (typeof uid !== "number")
    throw new Error("no numeric uid for private subagent RPC directory");
  const identity = String(uid);
  const dir = join(tmpdir(), `cpi-subagent-${identity}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {}
  try {
    const stat = lstatSync(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (typeof uid === "number" && stat.uid !== uid)
    )
      throw new Error("invalid private subagent RPC directory");
    chmodSync(dir, 0o700);
    return dir;
  } catch {
    throw new Error("no private short directory for subagent RPC");
  }
}

function endpointPath(): string {
  const nonce = randomBytes(16).toString("hex");
  if (process.platform === "win32")
    return `\\\\.\\pipe\\cpi-subagent-${process.pid}-${nonce}`;
  const filename = `cpi-subagent-${process.pid}-${nonce}.sock`;
  const runtimeDir = resolveRuntimeDir(process.env);
  if (
    runtimeDir &&
    Buffer.byteLength(join(runtimeDir, filename), "utf8") <=
      MAX_UNIX_SOCKET_PATH_BYTES
  )
    return join(runtimeDir, filename);
  return join(privateShortRuntimeDir(), filename);
}

function validRequest(value: unknown): value is Request {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<Request>;
  if (request.version !== 1) return false;
  if (!Array.isArray(request.argv) || request.argv.length > MAX_ARGV)
    return false;
  if (
    !request.argv.every((arg) => typeof arg === "string" && !arg.includes("\0"))
  )
    return false;
  if (
    typeof request.task !== "string" ||
    Buffer.byteLength(request.task) > MAX_TASK_BYTES
  )
    return false;
  if (
    !request.task ||
    typeof request.cwd !== "string" ||
    !request.cwd ||
    Buffer.byteLength(request.cwd) > 4096 ||
    request.cwd.includes("\0")
  )
    return false;
  if (
    typeof request.runId !== "string" ||
    !/^[a-zA-Z0-9-]{1,96}$/.test(request.runId)
  )
    return false;
  if (!request.env || typeof request.env !== "object") return false;
  return Object.entries(request.env).every(
    ([key, value]) =>
      key.length > 0 &&
      key.length <= 256 &&
      !key.includes("=") &&
      !key.includes("\0") &&
      typeof value === "string" &&
      !value.includes("\0"),
  );
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
  if (run.done) return;
  try {
    run.worker.postMessage({ kind: "abort" });
  } catch {}
  run.timer = setTimeout(() => void run.worker.terminate(), ABORT_GRACE_MS);
  run.timer.unref?.();
}

function launch(socket: Socket, request: Request, rpc: RpcState): void {
  if (rpc.active.size >= MAX_ACTIVE) {
    fail(socket, `subagent concurrency limit reached (${MAX_ACTIVE})`);
    return;
  }
  const env = {
    ...request.env,
    [CPI_SUBAGENT_RPC]: rpc.endpoint!,
    PI_SUBAGENT: "1",
  };
  let worker: Worker;
  try {
    worker = new Worker(WORKER_PATH, {
      workerData: request,
      env,
      stdout: true,
      stderr: true,
    });
  } catch (error) {
    fail(
      socket,
      error instanceof Error
        ? error.message
        : "failed to start subagent worker",
    );
    return;
  }
  const run: ActiveRun = { socket, worker, done: false, exitCode: 1 };
  rpc.active.add(run);
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
    run.done = true;
    if (run.timer) clearTimeout(run.timer);
    rpc.active.delete(run);
    send(socket, { kind: "done", exitCode: run.exitCode });
    socket.end();
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
    if (!validRequest(value)) {
      fail(socket, "invalid subagent RPC request");
      return;
    }
    launch(socket, value, rpc);
  };
  socket.on("data", onData);
  socket.on("error", () => {});
}

export async function ensureSubagentRpc(): Promise<string> {
  const rpc = state();
  if (rpc.endpoint && rpc.server?.listening) return rpc.endpoint;
  if (rpc.ready) return rpc.ready;
  rpc.ready = new Promise<string>((resolve, reject) => {
    const endpoint = endpointPath();
    if (process.platform !== "win32") {
      try {
        unlinkSync(endpoint);
      } catch {}
    }
    const server = createServer((socket) => accept(socket, rpc));
    server.maxConnections = MAX_ACTIVE;
    server.once("error", reject);
    server.listen(endpoint, () => {
      server.off("error", reject);
      if (process.platform !== "win32") chmodSync(endpoint, 0o600);
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
  for (const run of rpc.active) abortRun(run);
  const server = rpc.server;
  const endpoint = rpc.endpoint;
  rpc.server = undefined;
  rpc.endpoint = undefined;
  rpc.ready = undefined;
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (endpoint && process.platform !== "win32") {
    try {
      unlinkSync(endpoint);
    } catch {}
  }
}
