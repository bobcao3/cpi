import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRuntimeDir } from "../../tools/sh-monitor/runtime-dir.ts";

const MAX_UNIX_SOCKET_PATH_BYTES = 100;

function privateShortRuntimeDir(): string {
  const uid = process.getuid?.();
  if (typeof uid !== "number")
    throw new Error("no numeric uid for private subagent RPC directory");
  const dir = join(tmpdir(), `cpi-subagent-${uid}`);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch {}
  try {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid)
      throw new Error("invalid private subagent RPC directory");
    chmodSync(dir, 0o700);
    return dir;
  } catch {
    throw new Error("no private short directory for subagent RPC");
  }
}

export function createSubagentRpcEndpoint(): string {
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

export function secureSubagentRpcEndpoint(endpoint: string): void {
  if (process.platform === "win32") return;
  chmodSync(endpoint, 0o600);
}

export function removeSubagentRpcEndpoint(endpoint: string | undefined): void {
  if (!endpoint || process.platform === "win32") return;
  try {
    unlinkSync(endpoint);
  } catch {}
}
