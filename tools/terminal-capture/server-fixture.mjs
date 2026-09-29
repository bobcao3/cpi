import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const binary =
  process.env.TERMINAL_CAPTURE_BIN ??
  fileURLToPath(new URL("./zig-out/bin/terminal-capture", import.meta.url));
const execute = promisify(execFile);
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    async capture(uid) {
      return request(["capture-pane", "--uid", uid]);
    },
  };
}

export async function completed(f, uid) {
  return eventually(
    () => f.capture(uid),
    (value) => value.session.exit_code !== null,
    `${uid} must exit and retain output`,
  );
}
