/**
 * Extension-side sh-monitor client + launcher. Runs in the pi (node) process.
 *
 * `launchMonitor` spawns `bun sh-monitor.ts spawn …` detached and unref'd so the
 * supervisor (and its grandchild) outlive pi. pi talks to it over the spawned
 * stdin/stdout pipes — NO filesystem socket, NO bind race, NO /tmp dependency
 * (the original cluster failure). The typebox-defined framing from
 * `tools/sh-monitor/protocol.ts` rides raw on the pipes: control requests on
 * stdin, responses + zero-copy DATA frames on stdout.
 *
 * sh-monitor owns the grandchild's stdout/stderr pipe and drains it to a log
 * file, so pi can come and go without ever signalling the grandchild (no
 * SIGPIPE). If pi closes the pipe (detach / done), sh-monitor treats the
 * subscriber as gone, keeps draining to the log, and exits after the
 * grandchild — nohup-style. Readiness is the first `stat()` round-trip; if
 * sh-monitor crashed at spawn, `stat` rejects with the captured stderr + exit
 * info, so failures are diagnosable instead of a bare ENOENT.
 *
 * Resume (Phase 2): when a shell is backgrounded, pi asks sh-monitor to bind a
 * best-effort resume socket (`bindResume`) so a restarted pi can re-attach via
 * `ResumeClient`. The `{pid, sockPath, cmd}` record lives in the session folder
 * (`<sessionDir>/sh-mon/<pid>.json`) so a resumed pi can always find it; if the
 * socket is gone, the caller reports "could not locate or resume session shell".
 *
 * We deliberately do NOT import `sh-monitor.ts` here (its top-level `main()`
 * is a CLI side effect); we reuse only the pure `protocol.ts` (schema +
 * framing).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const SH_MONITOR_TS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tools",
  "sh-monitor",
  "sh-monitor.ts",
);
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

/** Synchronous client over the spawned stdin/stdout pipes. Never imports the CLI module. */
export class MonitorClient {
  private readonly stdin: NodeJS.WritableStream;
  private readonly reader: FrameReader;
  private subs = new Set<(ev: MonitorEvent) => void>();
  private pending: { resolve: (m: Message) => void; reject: (e: Error) => void }[] = [];
  private closeCbs = new Set<() => void>();
  private stderrBuf = "";
  private exitInfo: ExitInfo | null = null;
  readonly logPath: string;

  constructor(child: ChildProcess, logPath: string) {
    this.logPath = logPath;
    this.stdin = child.stdin as NodeJS.WritableStream;
    this.reader = new FrameReader({
      onControl: (m) => {
        if (m.kind === "exit") {
          const ev: MonitorEvent = { kind: "exit", exitCode: m.exitCode, bytes: m.bytes };
          for (const cb of this.subs) cb(ev);
        } else {
          this.pending.shift()?.resolve(m);
        }
      },
      onData: (off, buf) => {
        const ev: MonitorEvent = { kind: "data", off, buf };
        for (const cb of this.subs) cb(ev);
      },
      onFrameError: (reason) => this.fail(new Error(`sh-monitor protocol: ${reason}`)),
    });
    child.stdout!.on("data", (c: Buffer) => this.reader.feed(c));
    child.stdout!.on("close", () => this.fail(this.describeFailure()));
    child.stdout!.on("error", () => this.fail(this.describeFailure()));
    child.stdin!.on("error", () => this.fail(this.describeFailure()));
    child.stderr?.on("data", (c: Buffer) => {
      if (this.stderrBuf.length < STDERR_CAP) this.stderrBuf += c.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
    });
    child.on("error", (e) => {
      this.exitInfo = { code: null, signal: null, spawnError: e };
      this.fail(this.describeFailure());
    });
  }

  /** Fires once when the pipe closes (sh-monitor exited / crashed). */
  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }

  private describeFailure(): Error {
    const err = this.stderrBuf.trim();
    if (this.exitInfo?.spawnError) {
      const m = this.exitInfo.spawnError.message;
      return new Error(`sh-monitor spawn failed: ${m}${/ENOENT/i.test(m) ? " (is bun on PATH?)" : ""}`);
    }
    if (this.exitInfo) {
      const where =
        this.exitInfo.code !== null
          ? `exited (code ${this.exitInfo.code})`
          : `killed (signal ${this.exitInfo.signal})`;
      return new Error(`sh-monitor ${where}${err ? `: ${err.slice(0, 500)}` : ""}`);
    }
    return new Error(`sh-monitor pipe closed${err ? `: ${err.slice(0, 500)}` : ""}`);
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
  /** Best-effort: ask sh-monitor to bind a resume socket; returns its path or null. */
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
}

/**
 * Socket-based client for re-attaching to a still-living sh-monitor after a pi
 * restart (resume). Connects to the resume socket sh-monitor bound via
 * `bindResume`. `whenReady` rejects (ENOENT/ECONNREFUSED) if the supervisor is
 * gone — the caller treats that as "could not locate or resume session shell".
 */
export class ResumeClient {
  readonly sock: Socket;
  private readonly reader: FrameReader;
  private subs = new Set<(ev: MonitorEvent) => void>();
  readonly whenReady: Promise<void>;

  constructor(sockPath: string) {
    this.sock = connect(sockPath);
    this.reader = new FrameReader({
      onControl: (m) => {
        if (m.kind === "exit") {
          const ev: MonitorEvent = { kind: "exit", exitCode: m.exitCode, bytes: m.bytes };
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
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.sock.once("connect", () => resolve());
      this.sock.once("error", reject);
    });
  }

  subscribe(cb: (ev: MonitorEvent) => void): void {
    this.subs.add(cb);
    try {
      writeControl(this.sock, { kind: "subscribe" });
    } catch {}
  }

  close(): void {
    try {
      this.sock.end();
    } catch {}
  }
}

export interface ResumeRecord {
  pid: string;
  sockPath: string;
  cmd: string;
}

function resumeRecordDir(sessionDir: string): string {
  return join(sessionDir, RESUME_SUBDIR);
}

export async function writeResumeRecord(
  sessionDir: string,
  pid: string,
  sockPath: string,
  cmd: string,
): Promise<void> {
  try {
    const dir = resumeRecordDir(sessionDir);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${pid}.json`), JSON.stringify({ pid, sockPath, cmd }) + "\n");
  } catch {}
}

export async function readResumeRecords(sessionDir: string): Promise<ResumeRecord[]> {
  const dir = resumeRecordDir(sessionDir);
  try {
    const files = await readdir(dir);
    const out: ResumeRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(await readFile(join(dir, f), "utf8")) as ResumeRecord;
        if (rec && rec.pid && rec.sockPath) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeResumeRecord(sessionDir: string, pid: string): Promise<void> {
  try {
    await unlink(join(resumeRecordDir(sessionDir), `${pid}.json`));
  } catch {}
}

/** Spawn the detached supervisor and return a client over its stdin/stdout pipes. */
export async function launchMonitor(
  command: string,
  env: NodeJS.ProcessEnv,
  pathId: string,
): Promise<MonitorHandle> {
  const logPath = join(tmpdir(), `pi-sh-output-${pathId}.log`);
  const child = spawn(
    "bun",
    [SH_MONITOR_TS, "spawn", logPath, "--", "bash", "-c", command],
    { detached: true, stdio: ["pipe", "pipe", "pipe"], env },
  );
  child.unref();
  const client = new MonitorClient(child, logPath);
  return { client, logPath };
}
