/** Detached supervisor drains child output; resume records are scoped per session. */
import { type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import { connect, type Socket } from "node:net";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  writeControl,
  FrameReader,
  type Message,
  type StatusMsg,
  type SubscribedMsg,
  type ResumeReadyMsg,
  type OkMsg,
  type ErrMsg,
  type Request,
} from "../../tools/sh-monitor/protocol.ts";
import { resolveShell, type ShellProfile } from "./profile.ts";
import { spawnMonitor } from "./spawn-monitor.ts";

const STDERR_CAP = 8192;
const RESUME_SUBDIR = "sh-mon";

export type MonitorEvent =
  | { kind: "data"; off: number; buf: Buffer }
  | { kind: "exit"; exitCode: number; bytes: number };

export interface MonitorHandle {
  client: MonitorClient;
  logPath: string;
}

interface ExitInfo {
  code: number | null;
  signal: string | null;
  spawnError?: Error;
}

export class MonitorClient {
  private readonly stdin: NodeJS.WritableStream;
  private readonly child: ChildProcess;
  private readonly stdout: Readable | null;
  private readonly stderr: Readable | null;
  private readonly reader: FrameReader;
  private subs = new Set<(ev: MonitorEvent) => void>();
  private pending: {
    resolve: (m: Message) => void;
    reject: (e: Error) => void;
  }[] = [];
  private closeCbs = new Set<() => void>();
  private stderrBuf = "";
  private exitInfo: ExitInfo | null = null;
  readonly logPath: string;
  private readonly bin: string;

  constructor(child: ChildProcess, logPath: string, bin: string) {
    this.logPath = logPath;
    this.bin = bin;
    this.stdin = child.stdin as NodeJS.WritableStream;
    this.child = child;
    this.stdout = child.stdout;
    this.stderr = child.stderr;
    this.reader = new FrameReader({
      onControl: (m) => {
        if (m.kind === "exit") {
          const ev: MonitorEvent = {
            kind: "exit",
            exitCode: m.exitCode,
            bytes: m.bytes,
          };
          for (const cb of this.subs) cb(ev);
        } else {
          this.pending.shift()?.resolve(m);
        }
      },
      onData: (off, buf) => {
        const ev: MonitorEvent = { kind: "data", off, buf };
        for (const cb of this.subs) cb(ev);
      },
      onFrameError: (reason) =>
        this.fail(new Error(`sh-monitor protocol: ${reason}`)),
    });
    child.stdout!.on("data", (c: Buffer) => this.reader.feed(c));
    child.stdout!.on("close", () => this.fail(this.describeFailure()));
    child.stdout!.on("error", () => this.fail(this.describeFailure()));
    child.stdin!.on("error", () => this.fail(this.describeFailure()));
    child.stderr?.on("data", (c: Buffer) => {
      if (this.stderrBuf.length < STDERR_CAP)
        this.stderrBuf += c.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });
    child.on("error", (e) => {
      this.exitInfo = { code: null, signal: null, spawnError: e };
      this.fail(this.describeFailure());
    });
  }

  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }

  private describeFailure(): Error {
    const err = this.stderrBuf.trim();
    if (this.exitInfo?.spawnError) {
      const m = this.exitInfo.spawnError.message;
      return new Error(
        `sh-monitor spawn failed: ${m}${/ENOENT/i.test(m) ? ` (runtime binary: ${this.bin})` : ""}`,
      );
    }
    if (this.exitInfo) {
      const where =
        this.exitInfo.code !== null
          ? `exited (code ${this.exitInfo.code})`
          : `killed (signal ${this.exitInfo.signal})`;
      return new Error(
        `sh-monitor ${where}${err ? `: ${err.slice(0, 500)}` : ""}`,
      );
    }
    return new Error(
      `sh-monitor pipe closed${err ? `: ${err.slice(0, 500)}` : ""}`,
    );
  }

  private fail(err: Error): void {
    const pends = this.pending;
    this.pending = [];
    for (const p of pends) p.reject(err);
    if (this.closeCbs.size) {
      const cbs = this.closeCbs;
      this.closeCbs = new Set();
      for (const cb of cbs) cb();
    }
  }

  private call(req: Request): Promise<Message> {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.push(entry);
      try {
        writeControl(this.stdin, req);
      } catch (e) {
        const idx = this.pending.indexOf(entry);
        if (idx >= 0) this.pending.splice(idx, 1);
        reject(e);
      }
    });
  }

  stat(): Promise<StatusMsg> {
    return this.call({ kind: "stat" }) as Promise<StatusMsg>;
  }
  signal(sig: string): Promise<OkMsg | ErrMsg> {
    return this.call({ kind: "signal", sig }) as Promise<OkMsg | ErrMsg>;
  }
  /** Fire-and-forget signal without awaiting a reply. */
  sendSignal(sig: string): void {
    try {
      writeControl(this.stdin, { kind: "signal", sig });
    } catch {}
  }
  subscribe(cb: (ev: MonitorEvent) => void): Promise<SubscribedMsg> {
    this.subs.add(cb);
    return this.call({ kind: "subscribe" }) as Promise<SubscribedMsg>;
  }
  shutdown(): Promise<OkMsg> {
    return this.call({ kind: "shutdown" }) as Promise<OkMsg>;
  }
  bindResume(): Promise<string | null> {
    return this.call({ kind: "bindResume" }).then((m) =>
      m.kind === "resumeReady" ? m.sockPath : null,
    );
  }
  /** Fire-and-forget signal + close stdin (flushes the signal then EOF). */
  kill(sig: string): void {
    try {
      writeControl(this.stdin, { kind: "signal", sig });
    } catch {}
    try {
      this.stdin.end();
    } catch {}
  }
  close(): void {
    try {
      this.stdin.end();
    } catch {}
  }
  /**
   * Destroy every pipe handle pi holds so its libuv loop can idle (`pi --print`
   * exits): with a still-running grandchild the supervisor never exits, and an
   * open stdout pipe would keep the loop alive forever.
   */
  orphan(): void {
    try {
      this.child.unref();
    } catch {}
    try {
      this.child.stdin?.end();
    } catch {}
    try {
      this.child.stdin?.destroy();
    } catch {}
    try {
      this.stdout?.destroy();
    } catch {}
    try {
      this.stderr?.destroy();
    } catch {}
  }
}

/**
 * Re-attach to a still-living sh-monitor after a pi restart. `whenReady`
 * rejects if the supervisor is gone — caller treats the record as stale.
 */
export class ResumeClient {
  readonly sock: Socket;
  private readonly reader: FrameReader;
  private subs = new Set<(ev: MonitorEvent) => void>();
  private closeCbs = new Set<() => void>();
  readonly whenReady: Promise<void>;

  constructor(sockPath: string) {
    this.sock = connect(sockPath);
    this.reader = new FrameReader({
      onControl: (m) => {
        if (m.kind === "exit") {
          const ev: MonitorEvent = {
            kind: "exit",
            exitCode: m.exitCode,
            bytes: m.bytes,
          };
          for (const cb of this.subs) cb(ev);
        }
      },
      onData: (off, buf) => {
        const ev: MonitorEvent = { kind: "data", off, buf };
        for (const cb of this.subs) cb(ev);
      },
      onFrameError: () => this.sock.destroy(),
    });
    this.sock.on("data", (c: Buffer) => this.reader.feed(c));
    this.sock.on("close", () => {
      const cbs = this.closeCbs;
      this.closeCbs = new Set();
      for (const cb of cbs) cb();
    });
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.sock.once("connect", () => resolve());
      this.sock.once("error", reject);
    });
  }

  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }

  subscribe(cb: (ev: MonitorEvent) => void): void {
    this.subs.add(cb);
    try {
      writeControl(this.sock, { kind: "subscribe" });
    } catch {}
  }

  sendSignal(sig: string): void {
    try {
      writeControl(this.sock, { kind: "signal", sig });
    } catch {}
  }

  /** Fire-and-forget signal + close the socket (flushes the signal then EOF). */
  kill(sig: string): void {
    this.sendSignal(sig);
    try {
      this.sock.end();
    } catch {}
  }

  close(): void {
    try {
      this.sock.end();
    } catch {}
  }
  orphan(): void {
    try {
      this.sock.unref();
    } catch {}
    try {
      this.sock.destroy();
    } catch {}
  }
}

export interface ResumeRecord {
  pid: string;
  sockPath: string;
  cmd: string;
  logPath?: string;
  describe?: string;
}

function resumeRecordDir(sessionDir: string, scope: string): string {
  return join(sessionDir, RESUME_SUBDIR, scope);
}

export async function writeResumeRecord(
  sessionDir: string,
  scope: string,
  pid: string,
  sockPath: string,
  cmd: string,
  logPath?: string,
  describe?: string,
): Promise<void> {
  try {
    const dir = resumeRecordDir(sessionDir, scope);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sockPath, cmd, logPath, describe }) + "\n",
    );
  } catch {}
}

export async function readResumeRecords(
  sessionDir: string,
  scope: string,
): Promise<ResumeRecord[]> {
  const dir = resumeRecordDir(sessionDir, scope);
  try {
    const files = await readdir(dir);
    const out: ResumeRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          await readFile(join(dir, f), "utf8"),
        ) as ResumeRecord;
        if (rec && rec.pid && rec.sockPath) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeResumeRecord(
  sessionDir: string,
  scope: string,
  pid: string,
): Promise<void> {
  try {
    await unlink(join(resumeRecordDir(sessionDir, scope), `${pid}.json`));
  } catch {}
}

export interface CompletedRecord {
  pid: string;
  command: string;
  exitCode: number;
  logPath: string;
  completedAt: number;
}

function completedRecordDir(sessionDir: string, scope: string): string {
  return join(resumeRecordDir(sessionDir, scope), "done");
}

/** Persist an off-screen completion so the owner's resume can surface it. */
export async function writeCompletedRecord(
  sessionDir: string,
  scope: string,
  pid: string,
  rec: CompletedRecord,
): Promise<void> {
  try {
    const dir = completedRecordDir(sessionDir, scope);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${pid}.json`), JSON.stringify(rec) + "\n");
  } catch {}
}

export async function readCompletedRecords(
  sessionDir: string,
  scope: string,
): Promise<CompletedRecord[]> {
  const dir = completedRecordDir(sessionDir, scope);
  try {
    const files = await readdir(dir);
    const out: CompletedRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          await readFile(join(dir, f), "utf8"),
        ) as CompletedRecord;
        if (rec && rec.pid) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeCompletedRecord(
  sessionDir: string,
  scope: string,
  pid: string,
): Promise<void> {
  try {
    await unlink(join(completedRecordDir(sessionDir, scope), `${pid}.json`));
  } catch {}
}

export async function launchMonitor(
  command: string,
  env: NodeJS.ProcessEnv,
  pathId: string,
  shell: ShellProfile = resolveShell("bash"),
): Promise<MonitorHandle> {
  const { child, logPath, runtimeBin } = spawnMonitor(
    command,
    env,
    pathId,
    shell,
  );
  const client = new MonitorClient(child, logPath, runtimeBin);
  return { client, logPath };
}
