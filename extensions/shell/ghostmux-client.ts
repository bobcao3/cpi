import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { open, stat, writeFile, rename, readFile } from "node:fs/promises";
import { join, delimiter } from "node:path";
import { ghostmuxRequest, type NativeResponse } from "./ghostmux-transport.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";
import {
  ensureTargetDirectory,
  ghostmuxSocket,
  ghostmuxCommandDirectory,
  resolveGhostmuxBinary,
  readTarget,
  forgetTarget,
  rememberTarget,
  type SessionTarget,
} from "./ghostmux.ts";

export type MonitorEvent =
  | { kind: "data"; off: number; buf: Buffer }
  | { kind: "exit"; exitCode: number; bytes: number };
export class MonitorClient {
  readonly whenReady: Promise<void>;
  private callbacks = new Set<(event: MonitorEvent) => void>();
  private closes = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private offset = 0;
  private closed = false;
  private emittedExit = false;
  private nextProbe = 0;
  target?: SessionTarget;
  constructor(
    readonly statePath: string,
    initial?: SessionTarget,
  ) {
    this.target = initial;
    this.whenReady = readTarget(statePath).then((target) => {
      this.target = target;
    });
  }
  get logPath(): string {
    return this.target?.logPath ?? "";
  }
  async stat() {
    await this.whenReady;
    const target = await readTarget(this.statePath);
    this.target = target;
    return { pid: target.pid, bytes: target.bytes, exitCode: target.exitCode };
  }
  onClose(callback: () => void): void {
    this.closes.add(callback);
  }
  async subscribe(callback: (event: MonitorEvent) => void): Promise<void> {
    this.callbacks.add(callback);
    await this.whenReady;
    if (!this.timer && !this.closed) await this.poll();
    if (this.closed && !this.emittedExit)
      throw new Error(this.target?.error ?? "ghostmux monitor closed");
  }
  private async poll(): Promise<void> {
    if (this.closed) return;
    try {
      let target = await readTarget(this.statePath);
      if (
        this.target &&
        (target.pid !== this.target.pid ||
          target.serverPid !== this.target.serverPid)
      )
        throw new Error("ghostmux session identity changed");
      if (!target.completed && Date.now() >= this.nextProbe) {
        this.nextProbe = Date.now() + 1000;
        try {
          const response = await ghostmuxRequest(
            target.socketPath,
            { op: "list_sessions" },
            undefined,
            target.binaryPath,
          );
          if (!response.ok)
            throw new Error(response.error_name ?? "ghostmux daemon failed");
          if (response.server_pid !== target.serverPid)
            throw new Error("ghostmux daemon identity changed");
          if (
            !response.sessions?.some(
              (session) =>
                session.uid === target.uid && session.pid === target.pid,
            )
          ) {
            target = await readTarget(this.statePath);
            if (!target.completed)
              throw new Error(
                "ghostmux lost the shell session without a final status",
              );
          }
        } catch (error) {
          target = await readTarget(this.statePath);
          if (!target.completed) throw error;
        }
      }
      this.target = target;
      const length = (await stat(target.logPath)).size;
      if (length > this.offset) {
        const file = await open(target.logPath, "r");
        try {
          const buffer = Buffer.alloc(
            Math.min(length - this.offset, 256 * 1024),
          );
          const { bytesRead } = await file.read(
            buffer,
            0,
            buffer.length,
            this.offset,
          );
          const event: MonitorEvent = {
            kind: "data",
            off: this.offset,
            buf: buffer.subarray(0, bytesRead),
          };
          this.offset += bytesRead;
          for (const callback of this.callbacks) callback(event);
        } finally {
          await file.close();
        }
      }
      if (target.completed && this.offset >= length && !this.emittedExit) {
        this.emittedExit = true;
        for (const callback of this.callbacks)
          callback({
            kind: "exit",
            exitCode: target.exitCode ?? -1,
            bytes: length,
          });
        return;
      }
      if (!this.closed)
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.poll();
          },
          this.offset < length ? 0 : 50,
        );
    } catch (error) {
      if (this.target) this.target.error = String(error);
      if (this.closed) return;
      this.close();
      for (const callback of this.closes) callback();
    }
  }
  async signal(signal: string): Promise<void> {
    if (!this.target) await this.whenReady;
    const target = this.target!;
    const response = await ghostmuxRequest(
      target.socketPath,
      { op: "signal_session", uid: target.uid, signal },
      undefined,
      target.binaryPath,
    );
    if (!response.ok)
      throw new Error(response.error_name ?? "ghostmux signal failed");
  }
  sendSignal(signal: string): void {
    void this.signal(signal).catch(() => {});
  }
  kill(signal: string): void {
    this.sendSignal(signal);
  }
  async reap(): Promise<void> {
    if (!this.target) await this.whenReady;
    await reapLaunch(this.target!);
  }
  bindResume(): Promise<string> {
    return Promise.resolve(this.statePath);
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (this.target) forgetTarget(this.target);
  }
  orphan(): void {
    this.close();
  }
}
export class ResumeClient extends MonitorClient {}
export interface MonitorHandle {
  client: MonitorClient;
  logPath: string;
}
const execute = promisify(execFile);
export async function reapLaunch(
  target: Pick<
    SessionTarget,
    "uid" | "socketPath" | "statusPath" | "binaryPath"
  >,
): Promise<void> {
  let prevented = false;
  try {
    await writeFile(target.statusPath, JSON.stringify({ cancelled: true }), {
      flag: "wx",
      mode: 0o600,
    });
    prevented = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    try {
      prevented =
        JSON.parse(await readFile(target.statusPath, "utf8")).cancelled ===
        true;
    } catch {}
  }
  if (prevented) return;
  try {
    const response = await ghostmuxRequest(
      target.socketPath,
      { op: "kill_session", uid: target.uid },
      undefined,
      target.binaryPath,
    );
    if (!response.ok && response.error_name !== "UnknownUid")
      throw new Error(response.error_name ?? "ghostmux launch cleanup failed");
  } catch (error) {
    const native = JSON.parse(
      await readFile(target.statusPath, "utf8"),
    ) as NativeResponse;
    if (
      native.session?.exit_code !== null &&
      native.session?.exit_code !== undefined
    )
      return;
    throw new Error(`Cannot confirm shell launch cleanup: ${String(error)}`);
  }
}
export async function launchMonitor(
  command: string,
  env: NodeJS.ProcessEnv,
  shellId: string,
  shell: ShellProfile = resolveShell("bash"),
  cwd = process.cwd(),
  isPty = false,
  signal?: AbortSignal,
): Promise<MonitorHandle> {
  signal?.throwIfAborted();
  const binaryPath = await resolveGhostmuxBinary();
  signal?.throwIfAborted();
  const directory = await ensureTargetDirectory();
  const uid = `sh-${shellId}`;
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(uid))
    throw new Error("Invalid ghostmux shell UID");
  const statePath = join(directory, `${uid}.json`);
  const statusPath = join(directory, `${uid}.native.json`);
  const logPath = join(directory, `${uid}.log`);
  const socketPath = ghostmuxSocket(env);
  const target: SessionTarget = {
    uid,
    pid: 0,
    socketPath,
    binaryPath,
    logPath,
    statePath,
    statusPath,
    scope: env.PI_SESSION_ID,
    serverPid: 0,
    isPty,
    exitCode: null,
    bytes: 0,
    completed: false,
  };
  const key =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const commandDirectory = await ghostmuxCommandDirectory(binaryPath);
  const childEnv = {
    ...env,
    CPI_GHOSTMUX_SOCKET: socketPath,
    CPI_ACTIVITY_SHELL_LOG: logPath,
    [key]: `${commandDirectory}${delimiter}${env[key] ?? ""}`,
  };
  signal?.throwIfAborted();
  try {
    await stat(statusPath);
    throw new Error("ghostmux shell status already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeFile(statePath, JSON.stringify(target), {
    flag: "wx",
    mode: 0o600,
  });
  signal?.throwIfAborted();
  let cancellation: Promise<void> | undefined;
  let cleanupError: unknown;
  const abort = () => {
    cancellation = reapLaunch(target).catch((error) => {
      cleanupError = error;
    });
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const { stdout } = await execute(
      binaryPath,
      [
        "-S",
        socketPath,
        "new-session",
        "--uid",
        uid,
        "--is-pty",
        String(isPty),
        "--log",
        logPath,
        "--status-path",
        statusPath,
        "--cwd",
        cwd,
        "--json",
        "--",
        shell.executable,
        ...shell.commandArgs(command),
      ],
      {
        env: childEnv,
        cwd,
        timeout: 30000,
        maxBuffer: 65536,
        windowsHide: true,
      },
    );
    const response = JSON.parse(stdout) as NativeResponse;
    if (!response.ok || !response.session)
      throw new Error(
        response.error_name ?? "ghostmux launch returned no session",
      );
    target.pid = response.session.pid;
    target.serverPid = response.server_pid;
    if (signal?.aborted) throw new Error("Shell launch aborted");
    const index = join(directory, `pid-${target.pid}.json`);
    const temporary = `${index}.${uid}`;
    await writeFile(temporary, JSON.stringify({ statePath }), { mode: 0o600 });
    await rename(temporary, index);
    const ready = await readTarget(statePath);
    if (ready.pid !== target.pid || ready.serverPid !== target.serverPid)
      throw new Error("ghostmux launch identity changed");
    if (signal?.aborted) throw new Error("Shell launch aborted");
    rememberTarget(ready);
    return { client: new MonitorClient(statePath, ready), logPath };
  } catch (error) {
    if (cancellation) await cancellation;
    else await reapLaunch(target);
    if (cleanupError) throw cleanupError;
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
