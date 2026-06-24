/**
 * sh-monitor — nohup-style supervisor for pi background shells.
 *
 * pi spawns this detached (own session, SIGHUP ignored) so it outlives pi. It
 * owns the grandchild's stdout/stderr pipe and drains it to a log file, so pi
 * can come and go without ever signalling the grandchild (no SIGPIPE).
 *
 *   pi  ──stdin (control)──►  sh-monitor  ──pipe──►  grandchild
 *    │──stdout (resp+DATA)──▲        │
 *    │                               └─writes──► log file (durable drain)
 *
 * The default hot path is the stdin/stdout pipes — NO filesystem socket, so no
 * /tmp dependency, no bind race, no `connect ENOENT` (the cluster failure).
 *
 * Resume socket (best-effort, lazy): when a shell is backgrounded, pi sends
 * `bindResume`; sh-monitor binds an AF_UNIX socket in the per-user runtime dir
 * (resolveRuntimeDir) so a restarted pi can re-attach. Bind is non-fatal — if
 * the runtime dir is unavailable or bind fails, resume is simply unavailable
 * for that shell and the pipe hot path is unaffected. Detached shells never bind
 * one (they are nohup). The socket is unlinked on exit so a resumed pi sees a
 * clean ENOENT, which it treats as a stale record and removes silently (no notification).
 *
 * Control plane (stat/signal/subscribe/shutdown/bindResume) is JSON over the
 * framed stdin pipe; the data plane rides raw zero-copy DATA frames on stdout
 * (and, for resume subscribers, on their socket). Backpressure: stdout.write
 * ===false pauses the grandchild; resumes on 'drain', gated with the log
 * writeStream so the grandchild resumes only when BOTH sinks have drained.
 *
 * Wire format + schema live in `./protocol.ts` (typebox, validated at read).
 * Usage: sh-monitor spawn <log> -- <cmd> [args...]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket, type Server } from "node:net";
import { createWriteStream, existsSync, unlinkSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import {
  writeControl,
  writeData,
  FrameReader,
  type Message,
} from "./protocol.ts";
import { resolveRuntimeDir } from "./runtime-dir.ts";

const DRAIN_MS = 200; // grace after grandchild exit for subscribers to drain
const HARD_CAP_MS = 5000; // force-exit this long after grandchild exit even if a subscriber hangs
const MAX_LOG_BYTES = 64 * 1024 * 1024; // per-process log cap (64 MiB)
const MAX_SUBS = 8; // max simultaneous resume-socket subscribers

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

interface MonitorState {
  pid: number;
  exitCode: number | null;
  bytes: number;
  lines: number;
  logPath: string;
}

function runMonitor(logPath: string, cmd: string[]): void {
  // nohup-like: own session (pi spawns us detached), ignore terminal hangups.
  // SIGTERM means "stop supervising" → forward to grandchild.
  process.title = "sh-monitor";
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => forward("SIGTERM"));

  const child: ChildProcess = spawn(cmd[0], cmd.slice(1), {
    detached: true, // grandchild is its own pg leader; signals hit the group
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid ?? -1;
  const log: WriteStream = createWriteStream(logPath, { flags: "a" });
  const st: MonitorState = { pid, exitCode: null, bytes: 0, lines: 0, logPath };
  let childDone = false;
  let exitStartedAt = 0;
  let everSubscribed = false;
  let logCapped = false;
  let pipeSubscribed = false;
  let logBlocked = false;
  let stdoutBlocked = false;
  const sockSubs = new Set<Socket>(); // resume-socket subscribers
  let resumeServer: Server | null = null;
  let resumeSockPath: string | null = null;

  // Grandchild resumes only when both sinks (log + stdout) have drained.
  const resumeChild = (): void => {
    if (!logBlocked && !stdoutBlocked) {
      child.stdout?.resume();
      child.stderr?.resume();
    }
  };
  log.on("drain", () => {
    logBlocked = false;
    resumeChild();
  });
  process.stdout.on("drain", () => {
    stdoutBlocked = false;
    resumeChild();
  });
  // pi gone (read end closed) → EPIPE on next write; treat as subscriber gone.
  process.stdout.on("error", () => {
    pipeSubscribed = false;
    maybeExit();
  });

  const onChunk = (buf: Buffer): void => {
    if (logCapped) return;
    const off = st.bytes;
    if (!log.write(buf)) logBlocked = true;
    st.bytes += buf.length;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) st.lines++;
    if (pipeSubscribed && !writeData(process.stdout, off, buf)) stdoutBlocked = true;
    for (const s of sockSubs) {
      if (s.writable && !s.destroyed) writeData(s, off, buf); // zero-copy to resume subs
    }
    if (logBlocked || stdoutBlocked) {
      child.stdout?.pause();
      child.stderr?.pause();
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

  const exitMsg = (): Message => ({ kind: "exit", exitCode: st.exitCode ?? -1, bytes: st.bytes });
  const sendExitToSubs = (): void => {
    if (pipeSubscribed) writeControl(process.stdout, exitMsg());
    for (const s of sockSubs) {
      if (s.writable && !s.destroyed) writeControl(s, exitMsg());
    }
  };
  const maybeExit = (): void => {
    if (!childDone) return;
    const past = Date.now() - exitStartedAt >= HARD_CAP_MS;
    if (pipeSubscribed || sockSubs.size > 0) {
      if (past) process.exit(0); // force on hard cap
      return; // wait for subscribers to drain + close
    }
    if (everSubscribed || past) process.exit(0); // drained, or never-attached leak cap
  };
  const finish = (code: number | null): void => {
    if (childDone) return;
    childDone = true;
    exitStartedAt = Date.now();
    log.end(() => {
      st.exitCode = code;
      sendExitToSubs();
      setTimeout(maybeExit, DRAIN_MS);
    });
  };
  child.on("exit", (code, signal) => finish(code ?? (signal ? 128 + signum(signal) : -1)));
  child.on("error", () => finish(-1));
  if (pid <= 0) finish(-1);

  // Unlink the resume socket on exit so a resumed pi sees a clean ENOENT.
  process.on("exit", () => {
    try {
      resumeServer?.close();
    } catch {}
    try {
      if (resumeSockPath) unlinkSync(resumeSockPath);
    } catch {}
  });

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

  // Per-resume-socket handler (a restarted pi re-attaching).
  function handle(sock: Socket): void {
    if (sockSubs.size >= MAX_SUBS) {
      sock.destroy();
      return;
    }
    sockSubs.add(sock);
    everSubscribed = true;
    sock.on("close", () => {
      sockSubs.delete(sock);
      maybeExit();
    });
    const r = new FrameReader({
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
            writeControl(sock, { kind: "subscribed", offset: st.bytes });
            if (childDone) writeControl(sock, exitMsg());
            break;
          case "shutdown":
            forward("SIGTERM");
            writeControl(sock, { kind: "ok" });
            break;
          default:
            writeControl(sock, { kind: "err", message: `unexpected kind: ${msg.kind}` });
        }
      },
      onData() {
        // server never receives DATA frames
      },
      onFrameError() {
        sock.destroy();
      },
    });
    sock.on("data", (c: Buffer) => r.feed(c));
  }

  // Best-effort: bind the resume socket in the per-user runtime dir. Non-fatal.
  function bindResume(): void {
    if (resumeSockPath) {
      writeControl(process.stdout, { kind: "resumeReady", sockPath: resumeSockPath });
      return;
    }
    const dir = resolveRuntimeDir(process.env);
    if (!dir) {
      writeControl(process.stdout, { kind: "err", message: "no runtime dir for resume socket" });
      return;
    }
    const sp = join(dir, `pi-sh-mon-${pid}.sock`);
    try {
      if (existsSync(sp)) unlinkSync(sp);
    } catch {}
    let replied = false;
    const reply = (m: Message): void => {
      if (replied) return;
      replied = true;
      writeControl(process.stdout, m);
    };
    const srv = createServer(handle);
    srv.on("error", () => {
      resumeServer = null;
      reply({ kind: "err", message: "resume socket bind failed" });
    });
    srv.listen(sp, () => {
      resumeServer = srv;
      resumeSockPath = sp;
      reply({ kind: "resumeReady", sockPath: sp });
    });
  }

  const reader = new FrameReader({
    onControl(msg: Message) {
      switch (msg.kind) {
        case "stat":
          writeControl(process.stdout, {
            kind: "status",
            pid: st.pid,
            exitCode: st.exitCode,
            bytes: st.bytes,
            lines: st.lines,
            logPath: st.logPath,
          });
          break;
        case "signal":
          writeControl(process.stdout, forward(msg.sig) ? { kind: "ok" } : { kind: "err", message: "signal failed" });
          break;
        case "subscribe":
          // live DATA frames carry off >= this offset; client reads [cursor, offset) backlog from file
          pipeSubscribed = true;
          everSubscribed = true;
          writeControl(process.stdout, { kind: "subscribed", offset: st.bytes });
          if (childDone) sendExitToSubs();
          break;
        case "bindResume":
          bindResume();
          break;
        case "shutdown":
          forward("SIGTERM"); // drives finish()
          writeControl(process.stdout, { kind: "ok" });
          break;
        default:
          writeControl(process.stdout, { kind: "err", message: `unexpected kind: ${msg.kind}` });
      }
    },
    onData() {
      // server never receives DATA frames; ignore
    },
    onFrameError() {
      // pi sent a malformed frame; ignore (don't kill the supervisor over one bad control msg)
    },
  });
  process.stdin.on("data", (c: Buffer) => reader.feed(c));
  process.stdin.on("end", () => {
    // pi closed the pipe (detach / done) → pipe subscriber gone; keep draining, exit after grandchild
    pipeSubscribed = false;
    maybeExit();
  });
  process.stdin.on("error", () => {
    pipeSubscribed = false;
    maybeExit();
  });
}

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
      console.error("usage: sh-monitor spawn <log> -- <cmd> [args...]");
      return 2;
    }
    const [log] = split.before;
    if (!log) {
      console.error("usage: sh-monitor spawn <log> -- <cmd> [args...]");
      return 2;
    }
    runMonitor(log, split.after);
    return 0; // never reached while serving
  }
  console.error("usage: sh-monitor spawn <log> -- <cmd> [args...]");
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
