/**
 * Extension-side sh-monitor client + launcher. Runs in the pi (node) process.
 *
 * `launchMonitor` spawns `bun sh-monitor.ts spawn …` detached and unref'd so the
 * supervisor (and its child) outlive pi. pi then talks to it over the AF_UNIX
 * socket using the typebox-defined protocol from `tools/sh-monitor/protocol.ts`
 * — the same framing the standalone CLI uses. We deliberately do NOT import
 * `sh-monitor.ts` here (its top-level `main()` is a CLI side effect); we reuse
 * only the pure `protocol.ts` (schema + framing).
 */

import { spawn } from "node:child_process";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  writeControl,
  FrameReader,
  type Message,
  type StatusMsg,
  type SubscribedMsg,
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

const CONNECT_DEADLINE_MS = 3000;
const CONNECT_ATTEMPT_MS = 250;

export type MonitorEvent =
  | { kind: "data"; off: number; buf: Buffer }
  | { kind: "exit"; exitCode: number; bytes: number };

export interface MonitorHandle {
  client: MonitorClient;
  sockPath: string;
  logPath: string;
  statePath: string;
}

/** Synchronous client over the framed socket. Never imports the CLI module. */
export class MonitorClient {
  readonly sock: Socket;
  private reader: FrameReader;
  private subs = new Set<(ev: MonitorEvent) => void>();
  private pending: { resolve: (m: Message) => void; reject: (e: Error) => void }[] = [];
  readonly whenReady: Promise<void>;

  constructor(sockPath: string) {
    this.sock = connect(sockPath);
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
      onFrameError: (reason) => this.sock.destroy(new Error(reason)),
    });
    this.sock.on("data", (c: Buffer) => this.reader.feed(c));
    this.sock.on("close", () => this.failAll(new Error("socket closed")));
    this.sock.on("error", () => this.failAll(new Error("socket error")));
    this.whenReady = new Promise<void>((resolve, reject) => {
      this.sock.once("connect", () => resolve());
      this.sock.once("error", reject);
    });
  }

  private failAll(err: Error): void {
    const pends = this.pending;
    this.pending = [];
    for (const p of pends) p.reject(err);
  }

  private call(req: Request): Promise<Message> {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.push(entry);
      try {
        // writeControl only throws on body.length > MAX_FRAME — unreachable for normal control messages.
        writeControl(this.sock, req);
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
  /** Fire-and-forget signal without awaiting a reply; socket stays subscribed for the exit event. */
  sendSignal(sig: string): void {
    try {
      writeControl(this.sock, { kind: "signal", sig });
    } catch {}
  }
  subscribe(cb: (ev: MonitorEvent) => void): Promise<SubscribedMsg> {
    this.subs.add(cb);
    return this.call({ kind: "subscribe" }) as Promise<SubscribedMsg>;
  }
  shutdown(): Promise<OkMsg> {
    return this.call({ kind: "shutdown" }) as Promise<OkMsg>;
  }
  /** Fire-and-forget signal + close — for killAll (cannot round-trip mid-shutdown). */
  kill(sig: string): void {
    try {
      writeControl(this.sock, { kind: "signal", sig });
    } catch {}
    this.sock.destroy();
  }
  close(): void {
    this.sock.end();
  }
}

/** Spawn the detached supervisor and wait for its socket to come up. */
export async function launchMonitor(
  command: string,
  env: NodeJS.ProcessEnv,
  pathId: string,
): Promise<MonitorHandle> {
  const sockPath = join(tmpdir(), `pi-sh-mon-${pathId}.sock`);
  const logPath = join(tmpdir(), `pi-sh-output-${pathId}.log`);
  const statePath = join(tmpdir(), `pi-sh-mon-${pathId}.state`);
  const mon = spawn(
    "bun",
    [SH_MONITOR_TS, "spawn", sockPath, logPath, statePath, "--", "bash", "-c", command],
    { detached: true, stdio: "ignore", env },
  );
  mon.unref();
  mon.on("error", () => {}); // surfaced as connect failure below
  const client = await retryConnect(sockPath);
  return { client, sockPath, logPath, statePath };
}

async function retryConnect(sockPath: string): Promise<MonitorClient> {
  const deadline = Date.now() + CONNECT_DEADLINE_MS;
  for (;;) {
    const c = new MonitorClient(sockPath);
    try {
      await Promise.race([
        c.whenReady,
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error("connect attempt timeout")), CONNECT_ATTEMPT_MS),
        ),
      ]);
      return c;
    } catch (e) {
      c.kill("SIGKILL"); // destroy the half-open socket
      if (Date.now() >= deadline)
        throw new Error(`sh-monitor did not come up: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }
}
