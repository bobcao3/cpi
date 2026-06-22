#!/usr/bin/env bun
/**
 * sh-monitor — nohup-style supervisor for pi background shells.
 *
 * When pi holds a child's stdout/stderr *pipe* directly, pi's own exit closes
 * the read end and the child receives SIGPIPE/EPIPE on its next write. sh-monitor
 * sits between pi and the child: it owns the child's pipe and drains it to a log
 * file, so pi can come and go without ever signalling the child. The child never
 * sees SIGPIPE as long as sh-monitor lives, and sh-monitor is detached from pi
 * (own session, SIGHUP ignored) so it outlives pi.
 *
 *   pi  ──AF_UNIX socket──►  sh-monitor  ──pipe──►  child
 *    │        (control + live data)   │  │
 *    │ reads log file (backlog only)  │  └─writes──► log file (durable fallback)
 *    │                               └─writes──► state file (pid/exit/bytes)
 *
 * Controlled mode (subscriber attached): live stdio streams over the socket as
 * zero-copy DATA frames — pi never touches the log file. Detached (no subscriber):
 * output still drains to the file so the child never blocks. Late attachers read
 * the file backlog [cursor, liveStart) then consume live DATA frames (which all
 * carry off >= the offset returned by subscribe) — race-free, no gaps, no dupes.
 *
 * Lifecycle: sh-monitor spawns the child detached (own pg), writes state, serves
 * the socket, and exits ~200ms after the child exits once subscribers have drained;
 * force-exits after HARD_CAP_MS if no subscriber attaches or a subscriber hangs.
 * If pi is gone by then, the state file records the exit code.
 *
 * Wire format + control-message schema live in `./protocol.ts` (typebox-defined,
 * validated at the read boundary). Usage:
 *   sh-monitor spawn <sock> <log> <state> -- <cmd> [args...]
 *   sh-monitor stat    <sock>
 *   sh-monitor signal  <sock> <sig>
 *   sh-monitor tail    <sock> [startOffset]
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, connect, type Socket, type Server } from "node:net";
import { createWriteStream, writeFileSync, existsSync, unlinkSync, type WriteStream } from "node:fs";
import {
  writeControl,
  writeData,
  FrameReader,
  type Message,
  type StatusMsg,
  type SubscribedMsg,
  type OkMsg,
  type ErrMsg,
  type Request,
} from "./protocol.ts";

const DRAIN_MS = 200; // grace period after child exit for subscribers to drain
const HARD_CAP_MS = 5000; // force-exit this long after child exit even if a subscriber hangs
const MAX_LOG_BYTES = 64 * 1024 * 1024; // per-process log file size cap (64 MiB)
const MAX_SUBS = 8; // maximum simultaneous subscriber sockets

function signum(sig: string): number {
  switch (sig) {
    case "SIGHUP": return 1;
    case "SIGINT": return 2;
    case "SIGQUIT": return 3;
    case "SIGABRT": return 6;
    case "SIGKILL": return 9;
    case "SIGPIPE": return 13;
    case "SIGTERM": return 15;
    default: return 0;
  }
}

// ── monitor (server) mode ────────────────────────────────────────────────────

interface MonitorState {
  pid: number;
  exitCode: number | null;
  bytes: number;
  lines: number;
  logPath: string;
}

function runMonitor(sockPath: string, logPath: string, statePath: string, cmd: string[]): void {
  // nohup-like: own session (pi spawns us detached), ignore terminal hangups.
  // SIGTERM means "stop supervising" → forward to child.
  process.title = "sh-monitor";
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => forward("SIGTERM"));

  const child: ChildProcess = spawn(cmd[0], cmd.slice(1), {
    detached: true, // child is its own pg leader; signals hit the group
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid ?? -1;
  const log: WriteStream = createWriteStream(logPath, { flags: "a" });
  log.on("drain", () => { child.stdout?.resume(); child.stderr?.resume(); });
  const subs = new Set<Socket>();
  const st: MonitorState = { pid, exitCode: null, bytes: 0, lines: 0, logPath };
  let childDone = false; let exitStartedAt = 0; let everSubscribed = false; let logCapped = false;

  const writeState = () => writeFileSync(statePath, JSON.stringify(st) + "\n");

  const onChunk = (buf: Buffer): void => {
    if (logCapped) return;
    const off = st.bytes;
    if (!log.write(buf)) {
      child.stdout?.pause();
      child.stderr?.pause();
    }
    st.bytes += buf.length;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) st.lines++;
    for (const s of subs) {
      if (s.writable && !s.destroyed) writeData(s, off, buf); // zero-copy: header + child buf
    }
    if (st.bytes >= MAX_LOG_BYTES) {
      logCapped = true;
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(-1);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const sendExitToSubs = (): void => {
    for (const s of subs) {
      if (s.writable && !s.destroyed)
        writeControl(s, { kind: "exit", exitCode: st.exitCode ?? -1, bytes: st.bytes });
    }
  };
  const maybeExit = (): void => {
    if (!childDone) return;
    const past = Date.now() - exitStartedAt >= HARD_CAP_MS;
    if (subs.size > 0) {
      if (past) { server.close(); process.exit(0); } // force on hard cap
      else return; // wait for drain
    } else {
      if (everSubscribed || past) { server.close(); process.exit(0); } // drained, or never-attached leak cap
    }
  };
  const finish = (code: number | null): void => {
    if (childDone) return;
    childDone = true; exitStartedAt = Date.now();
    log.end(() => {
      st.exitCode = code;
      writeState();
      sendExitToSubs();
      setTimeout(maybeExit, DRAIN_MS);
    });
  };
  child.on("exit", (code, signal) => finish(code ?? (signal ? 128 + signum(signal) : -1)));
  child.on("error", () => finish(-1));
  if (pid <= 0) finish(-1);

  function forward(sig: string | number): boolean {
    if (st.exitCode !== null || pid <= 0) return false;
    let s: string | number = sig;
    if (typeof s === "string") {
      if (/^\d+$/.test(s)) s = Number(s);
      else if (!s.startsWith("SIG")) s = "SIG" + s.toUpperCase();
    }
    try {
      process.kill(-pid, s as NodeJS.Signals); // whole pg
      return true;
    } catch {
      return false;
    }
  }

  const handle = (sock: Socket): void => {
    if (subs.size >= MAX_SUBS) { sock.destroy(); return; }
    subs.add(sock); everSubscribed = true;
    sock.on("close", () => { subs.delete(sock); maybeExit(); });
    const reader = new FrameReader({
      onControl(msg: Message) {
        switch (msg.kind) {
          case "stat":
            writeControl(sock, {
              kind: "status",
              pid: st.pid,
              exitCode: st.exitCode,
              bytes: st.bytes,
              lines: st.lines,
              logPath: st.logPath,
            });
            break;
          case "signal":
            writeControl(sock, forward(msg.sig) ? { kind: "ok" } : { kind: "err", message: "signal failed" });
            break;
          case "subscribe":
            // live DATA frames will carry off >= this offset; client reads [cursor, offset) backlog from file
            writeControl(sock, { kind: "subscribed", offset: st.bytes });
            if (childDone)
              writeControl(sock, { kind: "exit", exitCode: st.exitCode ?? -1, bytes: st.bytes });
            break;
          case "shutdown":
            forward("SIGTERM"); // drives finish()
            writeControl(sock, { kind: "ok" });
            break;
          default:
            writeControl(sock, { kind: "err", message: `unexpected kind: ${msg.kind}` });
        }
      },
      onData() {
        // server never receives DATA frames; ignore (client-bound only)
      },
      onFrameError(reason) {
        sock.destroy(new Error(reason));
      },
    });
    sock.on("data", (c: Buffer) => reader.feed(c));
  };

  const server: Server = createServer(handle);
  if (existsSync(sockPath)) unlinkSync(sockPath);
  server.listen(sockPath, () => {
    writeState(); // publish pid so pi can attach before first output
  });
  server.on("error", (e) => {
    console.error(`sh-monitor: socket error: ${e.message}`);
    finish(-1);
  });
}

// ── client (importable + CLI) ────────────────────────────────────────────────

export type ClientEvent =
  | { kind: "data"; off: number; buf: Buffer }
  | { kind: "exit"; exitCode: number; bytes: number };

export class ShMonitorClient {
  private sock: Socket;
  private subs = new Set<(ev: ClientEvent) => void>();
  private pending: { resolve: (m: Message) => void; reject: (e: Error) => void }[] = [];
  private reader: FrameReader;

  private failAll(err: Error): void {
    for (const p of this.pending) p.reject(err);
    this.pending = [];
  }

  constructor(sockPath: string) {
    this.sock = connect(sockPath);
    this.reader = new FrameReader({
      onControl: (msg) => {
        if (msg.kind === "exit") {
          const ev: ClientEvent = { kind: "exit", exitCode: msg.exitCode, bytes: msg.bytes };
          for (const cb of this.subs) cb(ev);
        } else {
          this.pending.shift()?.resolve(msg);
        }
      },
      onData: (off, buf) => {
        const ev: ClientEvent = { kind: "data", off, buf };
        for (const cb of this.subs) cb(ev);
      },
      onFrameError: (reason) => {
        this.sock.destroy(new Error(reason));
      },
    });
    this.sock.on("data", (c: Buffer) => this.reader.feed(c));
    this.sock.on("close", () => this.failAll(new Error("socket closed")));
    this.sock.on("error", () => this.failAll(new Error("socket error")));
  }

  private call(req: Request): Promise<Message> {
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.pending.push(entry);
      try {
        // writeControl only throws on body.length > MAX_FRAME — unreachable for normal control messages.
        writeControl(this.sock, req);
      } catch (e) {
        const i = this.pending.indexOf(entry);
        if (i !== -1) this.pending.splice(i, 1);
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
  subscribe(cb: (ev: ClientEvent) => void): Promise<SubscribedMsg> {
    this.subs.add(cb);
    return this.call({ kind: "subscribe" }) as Promise<SubscribedMsg>;
  }
  shutdown(): Promise<OkMsg> {
    return this.call({ kind: "shutdown" }) as Promise<OkMsg>;
  }
  close(): void {
    this.sock.end();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function splitCmd(argv: string[]): { before: string[]; after: string[] } | null {
  const i = argv.indexOf("--");
  if (i === -1) return null;
  return { before: argv.slice(0, i), after: argv.slice(i + 1) };
}

async function main(argv: string[]): Promise<number> {
  const op = argv[0];
  if (op === "spawn") {
    const split = splitCmd(argv.slice(1));
    if (!split || split.after.length === 0) {
      console.error("usage: sh-monitor spawn <sock> <log> <state> -- <cmd> [args...]");
      return 2;
    }
    const [sock, log, state] = split.before;
    if (!sock || !log || !state) {
      console.error("usage: sh-monitor spawn <sock> <log> <state> -- <cmd> [args...]");
      return 2;
    }
    runMonitor(sock, log, state, split.after);
    return 0; // never reached while serving
  }
  if (op === "stat" || op === "signal") {
    const sock = argv[1];
    if (!sock) {
      console.error(`usage: sh-monitor ${op} <sock>${op === "signal" ? " <sig>" : ""}`);
      return 2;
    }
    const c = new ShMonitorClient(sock);
    const r = op === "stat" ? await c.stat() : await c.signal(argv[2] ?? "INT");
    c.close();
    console.log(JSON.stringify(r));
    return "message" in r ? 1 : 0;
  }
  if (op === "tail") {
    // Controlled mode: live stdio over the socket (zero-copy DATA frames). The
    // log file is read only for backlog before the live stream begins.
    const sock = argv[1];
    const start = Number(argv[2] ?? 0);
    if (!sock) {
      console.error("usage: sh-monitor tail <sock> [startOffset]");
      return 2;
    }
    const c = new ShMonitorClient(sock);
    const s = await c.stat();
    if (s.kind !== "status" || !s.logPath) {
      console.error("monitor unavailable");
      return 1;
    }
    const { open } = await import("node:fs/promises");
    const fd = await open(s.logPath, "r");
    let cursor = start;
    const backlog = async (upto: number) => {
      while (cursor < upto) {
        const buf = Buffer.alloc(Math.min(65536, upto - cursor));
        const { bytesRead } = await fd.read(buf, 0, buf.length, cursor);
        if (bytesRead <= 0) break;
        process.stdout.write(buf.subarray(0, bytesRead));
        cursor += bytesRead;
      }
    };
    let chain: Promise<void> = Promise.resolve();
    await c.subscribe((ev) => {
      chain = chain.then(async () => {
        if (ev.kind === "data") {
          await backlog(ev.off); // fill any gap [cursor, ev.off) from the file
          process.stdout.write(ev.buf);
          cursor = ev.off + ev.buf.length;
        } else {
          await backlog(ev.bytes ?? cursor); // flush trailing file backlog
          c.close();
          process.exit(0);
        }
      });
    });
    return 0;
  }
  console.error("usage: sh-monitor spawn|stat|signal|tail ...");
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
