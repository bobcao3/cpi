import type { Server, Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { chmodSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { socket_directory } from "./storage/paths.ts";

export function createSubagentRpcEndpoint(): string {
  const nonce = randomBytes(16).toString("hex");
  if (process.platform === "win32")
    return `\\\\.\\pipe\\cpi-subagent-${process.pid}-${nonce}`;
  const filename = `cpi-subagent-${process.pid}-${nonce}.sock`;
  return join(socket_directory("subagent", filename), filename);
}

export function secureSubagentRpcEndpoint(endpoint: string): void {
  if (process.platform === "win32") return;
  chmodSync(endpoint, 0o600);
}

export function removeSubagentRpcEndpoint(endpoint: string | undefined): void {
  if (!endpoint || process.platform === "win32") return;
  try {
    unlinkSync(endpoint);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function closeSubagentRpcListener(
  server: Server,
  endpoint: string | undefined,
  sockets: Socket[],
  activeSockets?: ReadonlySet<Socket>,
): Promise<void> {
  const listener = new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (
        error &&
        (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
      )
        reject(error);
      else resolve();
    });
  });
  const clients = sockets.map(
    (socket) =>
      new Promise<void>((resolve) => {
        if (socket.closed) return resolve();
        socket.once("close", () => resolve());
        if (activeSockets && !activeSockets.has(socket)) socket.destroy();
      }),
  );
  const settled = await Promise.allSettled([listener, ...clients]);
  const errors = settled.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (errors.length)
    throw new AggregateError(errors, "subagent RPC listener close failed");
  removeSubagentRpcEndpoint(endpoint);
}
