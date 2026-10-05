import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import { join } from "node:path";
import test from "node:test";
import { live, eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );

function packet(socketPath, bytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = net.createConnection(socketPath);
    socket.setTimeout(3000, () => socket.destroy(new Error("wire timeout")));
    socket.on("connect", () => socket.write(bytes));
    socket.on("data", (data) => chunks.push(data));
    socket.on("error", reject);
    socket.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  const buffer = Buffer.alloc(body.length + 4);
  buffer.writeUInt32BE(body.length);
  body.copy(buffer, 4);
  return buffer;
}

test(
  "a saturated Unix socket backlog returns an error instead of blocking connect",
  linux,
  async (t) => {
    const f = await fixture(t);
    const program = `import socket,sys,time
server=socket.socket(socket.AF_UNIX)
server.bind(sys.argv[1])
server.listen(1)
clients=[socket.socket(socket.AF_UNIX) for _ in range(2)]
for client in clients: client.connect(sys.argv[1])
print('ready',flush=True)
time.sleep(20)
`;
    const peer = spawn("python3", ["-c", program, f.socket]);
    t.after(() => peer.kill());
    await once(peer.stdout, "data");
    await assert.rejects(
      f.cli(["list-sessions"], { timeout: 1000 }),
      (error) => {
        assert.equal(error.killed, false);
        assert.match(error.stderr, /ServerBusy/);
        return true;
      },
    );
    peer.kill();
    await once(peer, "exit");
  },
);

test(
  "automatic session cleanup stops an idle server and permits the same UID on restart",
  linux,
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(f.cli(["list-sessions"]));
    assert.equal(await exists(f.socket), false);
    const start = () =>
      f.request([
        "new-session",
        "--uid",
        "one",
        "--",
        "/bin/sh",
        "-c",
        "printf READY; read value; printf FINAL; exit 7",
      ]);
    const first = await start();
    await live(f, "one");
    assert.equal((await lstat(f.socket)).mode & 0o777, 0o600);
    const subscriber = await f.wire({ op: "subscribe_output", uid: "one" });
    assert.equal((await subscriber.next()).event, "subscribed");
    await f.request(["send-input", "--uid", "one", "--text", "go\n"]);
    const chunks = [];
    let exit;
    for (let i = 0; i < 100; i++) {
      const response = await subscriber.next();
      if (response.event === "exit") {
        exit = response;
        break;
      }
      assert.equal(response.event, "data");
      chunks.push(Buffer.from(response.base64, "base64"));
    }
    assert.ok(exit);
    assert.equal(exit.eof, true);
    assert.match(Buffer.concat(chunks).toString(), /FINAL$/);
    await subscriber.ended;
    await eventually(
      () => exists(f.socket),
      (value) => !value,
      "empty server must unlink socket after the subscription closes",
    );
    await eventually(
      async () => {
        const stat = await readFile(
          `/proc/${first.server_pid}/stat`,
          "utf8",
        ).catch(() => "");
        return stat === "" || stat.split(") ")[1]?.startsWith("Z");
      },
      Boolean,
      "idle daemon process must exit",
    );
    const second = await start();
    assert.notEqual(second.server_pid, first.server_pid);
    assert.equal((await live(f, "one")).text, "READY");
  },
);

test(
  "startup recovers a stale socket after a server crash",
  linux,
  async (t) => {
    const f = await fixture(t);
    const first = await f.request([
      "new-session",
      "--uid",
      "before",
      "--",
      "/bin/sh",
      "-c",
      "printf READY; read value",
    ]);
    await live(f, "before");
    process.kill(first.server_pid, "SIGKILL");
    await eventually(
      async () => {
        const stat = await readFile(
          `/proc/${first.server_pid}/stat`,
          "utf8",
        ).catch(() => "");
        return stat === "" || stat.split(") ")[1]?.startsWith("Z");
      },
      Boolean,
      "old server must stop",
    );
    assert.equal(await exists(f.socket), true);
    const second = await f.request([
      "new-session",
      "--uid",
      "after",
      "--",
      "/bin/sh",
      "-c",
      "printf recovered; read value",
    ]);
    assert.notEqual(second.server_pid, first.server_pid);
    assert.equal((await live(f, "after")).text, "recovered");
  },
);

test(
  "unsafe socket directories, regular files, and symlink locks are never replaced",
  linux,
  async (t) => {
    const f = await fixture(t);
    const command = ["new-session", "--uid", "safe", "--", "true"];
    await chmod(f.directory, 0o777);
    await assert.rejects(f.cli(command));
    await chmod(f.directory, 0o700);
    await writeFile(f.socket, "preserve", { mode: 0o600 });
    await assert.rejects(f.cli(command));
    assert.equal(await readFile(f.socket, "utf8"), "preserve");
    const lockFixture = await fixture(t);
    const target = join(lockFixture.directory, "target");
    await writeFile(target, "untouched", { mode: 0o600 });
    await symlink(target, `${lockFixture.socket}.lock`);
    await assert.rejects(lockFixture.cli(command));
    assert.equal(await readFile(target, "utf8"), "untouched");
    assert.equal(await exists(lockFixture.socket), false);
  },
);

test(
  "partial and malformed clients cannot block terminal operations or kill the server",
  linux,
  async (t) => {
    const f = await fixture(t);
    const started = await f.request([
      "new-session",
      "--uid",
      "live",
      "--",
      "/bin/sh",
      "-c",
      'printf READY; read value; printf GOT:%s "$value"; read again',
    ]);
    await eventually(
      () => f.capture("live"),
      (value) => value.text.includes("READY"),
      "application must be ready",
    );
    const idle = net.createConnection(f.socket);
    t.after(() => idle.destroy());
    await new Promise((resolve, reject) =>
      idle.once("connect", resolve).once("error", reject),
    );
    idle.write(Buffer.from([0, 0]));
    await f.request(["send-input", "--uid", "live", "--text", "continued\n"]);
    const result = await live(f, "live", (value) =>
      value.text.includes("GOT:continued"),
    );
    assert.match(result.text, /GOT:continued/);
    assert.equal(result.server_pid, started.server_pid);
    const badVersion = await packet(
      f.socket,
      frame({ version: 999, op: "list_sessions" }),
    );
    assert.equal(badVersion.readUInt32BE(), badVersion.length - 4);
    assert.equal(
      JSON.parse(badVersion.subarray(4)).error_name,
      "ProtocolVersionMismatch",
    );
    const malformed = await packet(
      f.socket,
      frame({ op: "unknown_operation" }),
    );
    assert.equal(JSON.parse(malformed.subarray(4)).ok, false);
    const oversized = await packet(f.socket, Buffer.from([255, 255, 255, 255]));
    assert.equal(oversized.length, 0);
    assert.equal((await f.request(["list-sessions"])).sessions.length, 1);
    idle.destroy();
  },
);

test(
  "foreground termination and leader-exit cleanup leave sibling sessions intact",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request([
      "new-session",
      "--uid",
      "keep",
      "--",
      "/bin/sh",
      "-c",
      "printf retained; sleep 120",
    ]);
    const program = `import os,signal,sys,time
signal.signal(signal.SIGTTOU,signal.SIG_IGN)
signal.signal(signal.SIGHUP,signal.SIG_IGN)
mode=sys.argv[2]
child=os.fork()
if child==0:
    if mode=='foreground':
        os.setpgid(0,0)
        os.tcsetpgrp(0,os.getpid())
    print('CHILD:'+str(os.getpid()),flush=True)
    time.sleep(120)
elif mode=='foreground':
    os.waitpid(child,0)
else:
    sys.stdin.readline()
    os._exit(0)
`;
    for (const mode of ["foreground", "orphan"]) {
      await f.request([
        "new-session",
        "--uid",
        "victim",
        "--",
        "python3",
        "-c",
        program,
        f.directory,
        mode,
      ]);
      const capture = await eventually(
        () => f.capture("victim"),
        (value) => /CHILD:\d+/.test(value.text),
        "child process must start",
      );
      const child = Number(capture.text.match(/CHILD:(\d+)/)[1]);
      t.after(async () => {
        const command = await readFile(`/proc/${child}/cmdline`, "utf8").catch(
          () => "",
        );
        if (command.includes(f.directory)) {
          try {
            process.kill(child, "SIGKILL");
          } catch {}
        }
      });
      if (mode === "orphan") {
        const subscription = await f.wire({
          op: "subscribe_output",
          uid: "victim",
        });
        assert.equal((await subscription.next()).event, "subscribed");
        await f.request(["send-input", "--uid", "victim", "--text", "exit\n"]);
        let exit;
        for (let i = 0; i < 100; i++) {
          const response = await subscription.next();
          if (response.event === "exit") {
            exit = response;
            break;
          }
          assert.equal(response.event, "data");
          assert.equal(response.uid, "victim");
        }
        assert.ok(
          exit,
          "leader exit must finish the session even while a descendant retains the PTY",
        );
        assert.equal(exit.session.exit_code, 0);
        assert.equal(exit.eof, true);
        await subscription.ended;
      } else {
        await f.request(["kill-session", "--uid", "victim"]);
        await eventually(
          async () => {
            const stat = await readFile(`/proc/${child}/stat`, "utf8").catch(
              () => "",
            );
            return stat === "" || stat.split(") ")[1]?.startsWith("Z");
          },
          Boolean,
          "foreground child group must terminate",
        );
      }
      const keep = await f.capture("keep");
      assert.equal(keep.text, "retained");
      assert.equal(keep.session.exit_code, null);
      await assert.rejects(f.capture("victim"), /UnknownUid/);
    }
  },
);
