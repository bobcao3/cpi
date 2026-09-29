import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const binary =
  process.env.GHOSTMUX_BIN ??
  fileURLToPath(new URL("./zig-out/bin/ghostmux", import.meta.url));
const execute = promisify(execFile);
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

export async function wire(t, socketPath, request) {
  const socket = net.createConnection(socketPath);
  socket.setTimeout(8000);
  t.after(() => socket.destroy());

  const messages = [];
  let waiter;
  let failure;
  let buffer = Buffer.alloc(0);
  let expected = null;
  let endedResolve;
  const ended = new Promise((resolve) => {
    endedResolve = resolve;
  });
  const fail = (error) => {
    failure ??= error;
    if (waiter) {
      const pending = waiter;
      waiter = null;
      pending.reject(failure);
    }
  };

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (true) {
        if (expected === null) {
          if (buffer.length < 4) break;
          expected = buffer.readUInt32BE(0);
          buffer = buffer.subarray(4);
        }
        if (buffer.length < expected) break;
        messages.push(JSON.parse(buffer.subarray(0, expected).toString()));
        buffer = buffer.subarray(expected);
        expected = null;
        if (waiter) {
          const pending = waiter;
          waiter = null;
          pending.resolve(messages.shift());
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  socket.on("timeout", () =>
    socket.destroy(new Error("wire socket timed out")),
  );
  socket.on("error", fail);
  socket.on("end", () => {
    fail(
      buffer.length || expected !== null
        ? new Error("wire ended with a partial frame")
        : new Error("wire socket ended"),
    );
  });
  socket.on("close", () => {
    if (!failure) fail(new Error("wire socket closed"));
    endedResolve();
  });

  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(frame(request));

  return {
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      if (failure) return Promise.reject(failure);
      assert.ok(!waiter, "only one wire.next() may be pending");
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
      });
    },
    close() {
      socket.destroy();
    },
    ended,
  };
}

export async function eventually(read, accept, label) {
  const deadline = Date.now() + 8000;
  let value;
  while (Date.now() < deadline) {
    value = await read();
    if (accept(value)) return value;
    await pause(25);
  }
  assert.fail(`${label}: ${JSON.stringify(value)}`);
}

export async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tc-server-"));
  const socket = join(directory, "server.sock");
  const pids = new Set();
  const cli = async (args, options = {}) =>
    execute(binary, ["-S", socket, ...args], {
      timeout: 12000,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    });
  const request = async (args, options = {}) => {
    const separator = args.indexOf("--");
    const copy = [...args];
    copy.splice(separator < 0 ? copy.length : separator, 0, "--json");
    const result = await cli(copy, options);
    const reply = JSON.parse(result.stdout);
    assert.equal(reply.ok, true);
    pids.add(reply.server_pid);
    return reply;
  };
  t.after(async () => {
    await cli(["kill-server"]).catch(() => {});
    for (const pid of pids) {
      const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(
        () => "",
      );
      if (command.includes(socket)) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    socket,
    cli,
    request,
    wire(request) {
      return wire(t, socket, request);
    },
    async capture(uid) {
      return request(["capture-pane", "--uid", uid]);
    },
    async read(uid, offset = 0, limit = 65536) {
      return request([
        "read-output",
        "--uid",
        uid,
        "--offset",
        String(offset),
        "--limit",
        String(limit),
      ]);
    },
  };
}

export async function live(
  f,
  uid,
  predicate = (value) => value.text.length > 0,
) {
  const value = await eventually(
    () => f.capture(uid),
    predicate,
    `${uid} must produce live output`,
  );
  assert.equal(value.session.exit_code, null);
  return value;
}
