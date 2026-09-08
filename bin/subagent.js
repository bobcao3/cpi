#!/usr/bin/env node
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

const MAX_TASK_SIZE = 1024 * 1024;
// Each frame is validated against MAX_FRAME_BYTES individually. The server may
// coalesce a full worker burst into one TCP chunk, so the leftover backlog is
// bounded separately by the larger MAX_PENDING_BYTES.
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const USAGE =
  "usage: subagent [-p provider] [-m [provider/]model[:effort]] [-s session-id] [task]";

function parseArgs(argv) {
  const result = { task: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") return { ...result, task: argv.slice(i + 1) };
    if (arg === "-p" || arg === "-m" || arg === "-s") {
      const value = argv[++i];
      if (!value) throw new Error(USAGE);
      continue;
    }
    if (arg.startsWith("-")) throw new Error(USAGE);
    result.task.push(arg);
  }
  return result;
}

function checkTaskSize(task) {
  if (Buffer.byteLength(task) > MAX_TASK_SIZE)
    throw new Error("task exceeds 1 MiB");
  return task;
}

async function readTask(positional) {
  if (positional.length) return checkTaskSize(positional.join(" "));
  if (process.stdin.isTTY) throw new Error(USAGE);
  let task = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    task += chunk;
    checkTaskSize(task);
  }
  if (!task) throw new Error(USAGE);
  return task;
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    Buffer.from(value, "base64").toString("base64") !== value
  ) {
    throw new Error("malformed RPC data event");
  }
  return Buffer.from(value, "base64");
}

function runRpc(endpoint, request, signal) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let pending = Buffer.alloc(0);
    let done = false;
    let blocked = false;
    let closed = false;
    const fail = (error) => {
      if (done) return;
      done = true;
      socket.destroy();
      reject(error);
    };
    const event = (line) => {
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES)
        throw new Error("RPC response frame exceeds 256 KiB");
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error("malformed RPC event");
      }
      if (!message || typeof message !== "object")
        throw new Error("malformed RPC event");
      if (
        message.kind === "data" &&
        (message.stream === "stdout" || message.stream === "stderr")
      ) {
        const destination = process[message.stream];
        if (!destination.write(decodeBase64(message.data))) {
          blocked = true;
          socket.pause();
          destination.once("drain", () => {
            blocked = false;
            drain();
            if (!blocked && !done) socket.resume();
          });
        }
      } else if (
        message.kind === "error" &&
        typeof message.message === "string"
      ) {
        throw new Error(message.message);
      } else if (
        message.kind === "done" &&
        Number.isInteger(message.exitCode)
      ) {
        done = true;
        socket.end();
        resolve(message.exitCode);
      } else {
        throw new Error("malformed RPC event");
      }
    };
    const drain = () => {
      let newline;
      while (!done && !blocked && (newline = pending.indexOf(0x0a)) >= 0) {
        const line = pending.subarray(0, newline).toString("utf8");
        pending = pending.subarray(newline + 1);
        try {
          event(line);
        } catch (error) {
          fail(error);
        }
      }
      if (closed && !done && !blocked) fail(new Error("RPC connection closed"));
    };
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      drain();
      if (pending.length > MAX_PENDING_BYTES)
        return fail(new Error("RPC response backlog exceeds 8 MiB"));
    });
    socket.once("error", fail);
    socket.once("close", () => {
      closed = true;
      if (!done && !blocked)
        fail(
          signal.aborted
            ? new Error("aborted")
            : new Error("RPC connection closed"),
        );
    });
    signal.addEventListener("abort", () => fail(new Error("aborted")), {
      once: true,
    });
  });
}

async function run() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const task = await readTask(args.task);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([, value]) => typeof value === "string",
    ),
  );
  const request = {
    version: 1,
    argv,
    task,
    cwd: process.cwd(),
    env,
    runId: randomUUID(),
  };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const endpoint = process.env.CPI_SUBAGENT_RPC;
    if (typeof endpoint !== "string" || endpoint.length === 0)
      throw new Error("launch subagent through root pi's sh tool");
    const exitCode = await runRpc(endpoint, request, controller.signal);
    if (Number.isInteger(exitCode)) process.exitCode = exitCode;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
