/** Keeps detached child output drainable and supports framed control/data with resumable subscribers. */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Socket, type Server } from "node:net";
import {
  createWriteStream,
  existsSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { join } from "node:path";
import {
  writeControl,
  writeData,
  FrameReader,
  type Message,
} from "./protocol.ts";
import { resolveRuntimeDir } from "./runtime-dir.ts";

const DRAIN_MS = 200;
const HARD_CAP_MS = 5000;
const MAX_LOG_BYTES = 64 * 1024 * 1024; // Bound each process log.
const MAX_SUBS = 8; // Bound resume-socket subscribers.

function signum(sig: string): number {
  switch (sig) {
    case "SIGHUP":
      return 1;
    case "SIGINT":
      return 2;
    case "SIGQUIT":
      return 3;
    case "SIGABRT":
      return 6;
    case "SIGKILL":
      return 9;
    case "SIGPIPE":
      return 13;
    case "SIGTERM":
      return 15;
    default:
      return 0;
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
  process.title = "sh-monitor";
  process.on("SIGHUP", () => {});
  process.on("SIGTERM", () => forward("SIGTERM"));

  const child: ChildProcess = spawn(cmd[0], cmd.slice(1), {
    detached: true,
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
  const sockSubs = new Set<Socket>();
  let resumeServer: Server | null = null;
  let resumeSockPath: string | null = null;

  // Resume the child only after both sinks drain.
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
  // A closed pi pipe means the subscriber is gone.
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
    if (pipeSubscribed && !writeData(process.stdout, off, buf))
      stdoutBlocked = true;
    for (const s of sockSubs) {
      if (s.writable && !s.destroyed) writeData(s, off, buf);
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

  const exitMsg = (): Message => ({
    kind: "exit",
    exitCode: st.exitCode ?? -1,
    bytes: st.bytes,
  });
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
      if (past) process.exit(0);
      return;
    }
    if (everSubscribed || past) process.exit(0);
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
  child.on("exit", (code, signal) =>
    finish(code ?? (signal ? 128 + signum(signal) : -1)),
  );
  child.on("error", () => finish(-1));
  if (pid <= 0) finish(-1);

  // Remove the resume socket so resumed clients see ENOENT.
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
      process.kill(-pid, s as NodeJS.Signals);
      return true;
    } catch {
      return false;
    }
  }

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
            writeControl(
              sock,
              forward(msg.sig)
                ? { kind: "ok" }
                : { kind: "err", message: "signal failed" },
            );
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
            writeControl(sock, {
              kind: "err",
              message: `unexpected kind: ${msg.kind}`,
            });
        }
      },
      onData() {},
      onFrameError() {
        sock.destroy();
      },
    });
    sock.on("data", (c: Buffer) => r.feed(c));
  }

  function bindResume(): void {
    if (resumeSockPath) {
      writeControl(process.stdout, {
        kind: "resumeReady",
        sockPath: resumeSockPath,
      });
      return;
    }
    const dir = resolveRuntimeDir(process.env);
    if (!dir) {
      writeControl(process.stdout, {
        kind: "err",
        message: "no runtime dir for resume socket",
      });
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
          writeControl(
            process.stdout,
            forward(msg.sig)
              ? { kind: "ok" }
              : { kind: "err", message: "signal failed" },
          );
          break;
        case "subscribe":
          // Live frames start at this offset; the client reads earlier bytes from the log.
          pipeSubscribed = true;
          everSubscribed = true;
          writeControl(process.stdout, {
            kind: "subscribed",
            offset: st.bytes,
          });
          if (childDone) sendExitToSubs();
          break;
        case "bindResume":
          bindResume();
          break;
        case "shutdown":
          forward("SIGTERM");
          writeControl(process.stdout, { kind: "ok" });
          break;
        default:
          writeControl(process.stdout, {
            kind: "err",
            message: `unexpected kind: ${msg.kind}`,
          });
      }
    },
    onData() {},
    onFrameError() {
      // Ignore malformed control input; the supervisor must keep draining.
    },
  });
  process.stdin.on("data", (c: Buffer) => reader.feed(c));
  process.stdin.on("end", () => {
    // The pipe subscriber is gone; keep draining until the child exits.
    pipeSubscribed = false;
    maybeExit();
  });
  process.stdin.on("error", () => {
    pipeSubscribed = false;
    maybeExit();
  });
}

function splitCmd(
  argv: string[],
): { before: string[]; after: string[] } | null {
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
    return 0;
  }
  console.error("usage: sh-monitor spawn <log> -- <cmd> [args...]");
  return 2;
}

const code = await main(process.argv.slice(2));
if (code !== 0) process.exit(code);
