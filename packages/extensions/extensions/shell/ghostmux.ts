import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  symlink,
  copyFile,
  chmod,
  stat,
  link,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ghostmuxRequest, type NativeResponse } from "./ghostmux-transport.ts";
import { resolveGhostmux } from "@cpi/ghostmux/resolve";

const execute = promisify(execFile);
const name = process.platform === "win32" ? "ghostmux.exe" : "ghostmux";
export interface SessionTarget {
  uid: string;
  pid: number;
  socketPath: string;
  binaryPath: string;
  logPath: string;
  statePath: string;
  statusPath: string;
  scope?: string;
  serverPid: number;
  isPty: boolean;
  exitCode: number | null;
  bytes: number;
  completed: boolean;
  error?: string;
}
const shared = globalThis as typeof globalThis & {
  __cpiGhostmuxTargets?: Map<string, SessionTarget>;
  __cpiGhostmuxScope?: { id?: string };
};
const targets = (shared.__cpiGhostmuxTargets ??= new Map<
  string,
  SessionTarget
>());
const scope = (shared.__cpiGhostmuxScope ??= {});
export function setTargetScope(id: string | undefined): void {
  scope.id = id;
}
export function forgetTarget(target: SessionTarget): void {
  for (const key of [String(target.pid), target.uid]) {
    if (targets.get(key)?.uid === target.uid) targets.delete(key);
  }
}
export function rememberTarget(target: SessionTarget): void {
  if (target.completed) {
    forgetTarget(target);
    return;
  }
  targets.set(String(target.pid), target);
  targets.set(target.uid, target);
}
function targetDirectory(): string {
  const root = process.platform === "darwin" ? "/tmp" : tmpdir();
  return join(root, `cpi-ghostmux-${process.getuid?.() ?? "win32"}`);
}
export function ghostmuxSocket(env: NodeJS.ProcessEnv): string {
  const scope = createHash("sha256")
    .update(env.PI_SESSION_ID ?? `process-${process.pid}`)
    .digest("hex")
    .slice(0, 32);
  return join(targetDirectory(), `${scope}.sock`);
}
export async function resolveGhostmuxBinary(): Promise<string> {
  return resolveGhostmux();
}
export async function ghostmuxCommandDirectory(
  binary: string,
): Promise<string> {
  const source = await stat(binary, { bigint: true });
  const identity =
    process.platform === "win32"
      ? `${binary}\0${source.size}\0${source.mtimeNs}\0${source.ctimeNs}`
      : binary;
  const directory = join(
    await ensureTargetDirectory(),
    `bin-${createHash("sha256").update(identity).digest("hex").slice(0, 16)}`,
  );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, name);
  if (process.platform === "win32") {
    try {
      await stat(destination);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try {
      await copyFile(binary, temporary, constants.COPYFILE_EXCL);
      await chmod(temporary, 0o700);
      try {
        await link(temporary, destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await rm(temporary, { force: true });
    }
  } else {
    try {
      await symlink(binary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  return directory;
}
export async function ghostmuxRpc(
  target: Pick<SessionTarget, "socketPath" | "binaryPath" | "uid"> & {
    serverPid?: number;
  },
  args: string[],
  signal?: AbortSignal,
): Promise<any> {
  const { stdout } = await execute(
    target.binaryPath,
    ["-S", target.socketPath, ...args, "--uid", target.uid, "--json"],
    { signal, timeout: 10000, maxBuffer: 12 * 1024 * 1024, windowsHide: true },
  );
  const response = JSON.parse(stdout);
  if (
    target.serverPid !== undefined &&
    response.server_pid !== target.serverPid
  )
    throw new Error("ghostmux daemon identity changed");
  if (!response.ok)
    throw new Error(response.error_name ?? "ghostmux request failed");
  return response;
}
export async function getSessionTarget(
  id: string,
  signal?: AbortSignal,
): Promise<SessionTarget> {
  signal?.throwIfAborted();
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(id))
    throw new Error(`Invalid shell session ${id}`);
  const directory = await ensureTargetDirectory();
  let target: SessionTarget;
  try {
    const statePath = /^\d+$/.test(id)
      ? JSON.parse(await readFile(join(directory, `pid-${id}.json`), "utf8"))
          .statePath
      : (targets.get(id)?.statePath ?? join(directory, `${id}.json`));
    target = await readTarget(statePath);
  } catch {
    throw new Error(`Unknown shell session ${id}`);
  }
  if (target.scope !== scope.id)
    throw new Error(`Shell ${id} belongs to another session`);
  if (!target.completed) {
    const response = await ghostmuxRequest(
      target.socketPath,
      { op: "list_sessions" },
      signal,
      target.binaryPath,
    );
    if (!response.ok || response.server_pid !== target.serverPid)
      throw new Error("ghostmux daemon identity changed");
    if (
      !response.sessions?.some(
        (session) => session.uid === target.uid && session.pid === target.pid,
      )
    ) {
      target = await readTarget(target.statePath);
      if (!target.completed)
        throw new Error(`Shell ${id} is no longer retained by ghostmux`);
    }
  }
  if (/^\d+$/.test(id) && target.pid !== Number(id))
    throw new Error(`Shell PID ${id} identity changed`);
  if (/^\d+$/.test(id) && target.completed)
    throw new Error(
      `Shell PID ${id} has completed; use the UID for retained status`,
    );
  return target;
}
export async function captureSessionScreenshot(
  id: string,
  path: string,
  fontSize?: number,
  signal?: AbortSignal,
): Promise<SessionTarget> {
  signal?.throwIfAborted();
  const target = await getSessionTarget(id, signal);
  if (target.completed)
    throw new Error(
      `Shell ${id} has completed; ghostmux no longer retains the terminal`,
    );
  if (!target.isPty)
    throw new Error(
      `Shell ${id} uses pipes; launch with is_pty=true for terminal capture`,
    );
  const response = await ghostmuxRpc(
    target,
    [
      "screenshot",
      "--output",
      resolve(path),
      ...(fontSize === undefined ? [] : ["--font-size", String(fontSize)]),
    ],
    signal,
  );
  if (!response.path)
    throw new Error("ghostmux did not return a screenshot path");
  return target;
}
export async function readTarget(path: string): Promise<SessionTarget> {
  const metadata = JSON.parse(await readFile(path, "utf8")) as SessionTarget;
  if ((await stat(metadata.statusPath)).size > 65536)
    throw new Error("ghostmux status file exceeds the size limit");
  const native = JSON.parse(
    await readFile(metadata.statusPath, "utf8"),
  ) as NativeResponse;
  const status = native.session;
  if (
    !status ||
    status.uid !== metadata.uid ||
    !Number.isInteger(status.pid) ||
    status.pid <= 0 ||
    !Number.isInteger(native.server_pid) ||
    native.server_pid <= 0 ||
    (status.exit_code !== null && !Number.isInteger(status.exit_code)) ||
    status.is_pty !== metadata.isPty ||
    (metadata.pid !== 0 && status.pid !== metadata.pid) ||
    (metadata.serverPid !== 0 && native.server_pid !== metadata.serverPid)
  ) {
    throw new Error("ghostmux session identity or status changed");
  }
  const target: SessionTarget = {
    ...metadata,
    pid: status.pid,
    bytes: (await stat(metadata.logPath)).size,
    completed: status.exit_code !== null,
    exitCode: status.exit_code,
    serverPid: native.server_pid,
    error: native.error_name ?? undefined,
  };
  rememberTarget(target);
  return target;
}
export async function ensureTargetDirectory(): Promise<string> {
  const path = targetDirectory();
  await execute(await resolveGhostmuxBinary(), ["prepare-runtime", path], {
    windowsHide: true,
    timeout: 10000,
  });
  return path;
}
