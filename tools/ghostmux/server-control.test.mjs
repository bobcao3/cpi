import assert from "node:assert/strict";
import { constants } from "node:os";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };

async function completion(stream, uid, code) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < 1000; i++) {
    const message = await stream.next();
    assert.equal(message.ok, true, message.error_name);
    assert.equal(message.uid, uid);
    assert.equal(message.offset, offset);
    if (message.event === "exit") {
      assert.equal(message.session.exit_code, code);
      assert.equal(message.eof, true);
      assert.equal(message.next_offset, offset);
      await stream.ended;
      return Buffer.concat(chunks);
    }
    assert.equal(message.event, "data");
    const bytes = Buffer.from(message.base64, "base64");
    offset += bytes.length;
    assert.equal(message.next_offset, offset);
    chunks.push(bytes);
  }
  assert.fail("launch must complete within 1000 frames");
}

test(
  "atomic CLI launch delivers immediate output and completion on a fresh daemon",
  linux,
  async (t) => {
    const f = await fixture(t);
    for (let i = 0; i < 12; i++) {
      const text = `instant-${i}`;
      const result = await f.cli([
        "new-session",
        "--uid",
        "instant",
        "--subscribe",
        "--json",
        "--",
        "/bin/sh",
        "-c",
        `printf ${text}; exit 17`,
      ]);
      const messages = result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const first = messages.shift();
      assert.equal(first.ok, true);
      assert.equal(first.event, "subscribed");
      assert.equal(first.uid, "instant");
      assert.ok(first.session.pid > 0);
      assert.equal(first.session.exit_code, null);
      assert.equal(first.offset, 0);
      const last = messages.pop();
      assert.equal(last.event, "exit");
      assert.equal(last.session.exit_code, 17);
      assert.equal(last.offset, Buffer.byteLength(text));
      let offset = 0;
      const output = messages.map((message) => {
        assert.equal(message.event, "data");
        assert.equal(message.uid, "instant");
        assert.equal(message.offset, offset);
        const chunk = Buffer.from(message.base64, "base64");
        offset += chunk.length;
        assert.equal(message.next_offset, offset);
        return chunk;
      });
      assert.equal(Buffer.concat(output).toString(), text);
    }
    const raw = await f.cli([
      "new-session",
      "--uid",
      "raw",
      "--subscribe",
      "--",
      "/bin/sh",
      "-c",
      "printf raw-output; exit 9",
    ]);
    assert.equal(raw.stdout, "raw-output");
  },
);

test(
  "atomic wire launch streams beyond retained output and rejects failed launches cleanly",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request(["new-session", "--uid", "keeper", "--", "sleep", "120"]);
    const bad = await f.wire({
      op: "new_session",
      uid: "bulk",
      subscribe: true,
      argv: ["missing-ghostmux-executable"],
      env: ["PATH=/usr/bin:/bin"],
      cwd: f.directory,
    });
    const badReply = await bad.next();
    assert.equal(badReply.ok, false);
    assert.equal(badReply.error_name, "ExecutableNotFound");
    await bad.ended;
    const log = join(f.directory, "bulk.log");
    const pattern = Buffer.from("Q".repeat(79) + "\r");
    const repetitions = 32768;
    const stream = await f.wire({
      op: "new_session",
      uid: "bulk",
      subscribe: true,
      argv: [
        "python3",
        "-c",
        `import os,tty\ntty.setraw(0)\ndata=(b'Q'*79+b'\\r')*${repetitions}\nwhile data: data=data[os.write(1,data):]\nos._exit(29)`,
      ],
      env: ["PATH=/usr/bin:/bin"],
      cwd: f.directory,
      log_path: log,
    });
    const first = await stream.next();
    assert.equal(first.event, "subscribed");
    assert.ok(first.session.pid > 0);
    const expected = Buffer.concat(Array(repetitions).fill(pattern));
    assert.deepEqual(await completion(stream, "bulk", 29), expected);
    assert.deepEqual(await readFile(log), expected);
    await assert.rejects(f.capture("bulk"), /UnknownUid/);
  },
);

test(
  "signals reach leader and foreground groups without removing a live session",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request(["new-session", "--uid", "keeper", "--", "sleep", "120"]);
    const program = `import os,signal
signal.signal(signal.SIGTTOU,signal.SIG_IGN)
signal.signal(signal.SIGHUP,signal.SIG_IGN)
signal.signal(signal.SIGUSR1,lambda *_: os.write(1,b'P'))
signal.signal(signal.SIGTERM,lambda *_: os.write(1,b'L'))
child=os.fork()
if child==0:
    os.setpgid(0,0)
    os.tcsetpgrp(0,os.getpid())
    signal.signal(signal.SIGUSR1,lambda *_: os.write(1,b'F'))
    def finish(*_):
        os.write(1,b'T')
        os._exit(0)
    signal.signal(signal.SIGTERM,finish)
    os.write(1,b'R')
    while True: signal.pause()
else:
    os.waitpid(child,0)
    os._exit(23)
`;
    const stream = await f.wire({
      op: "new_session",
      uid: "signals",
      subscribe: true,
      argv: ["python3", "-c", program],
      env: ["PATH=/usr/bin:/bin"],
      cwd: f.directory,
    });
    assert.equal((await stream.next()).event, "subscribed");
    await eventually(
      () => f.read("signals"),
      (r) => Buffer.from(r.base64, "base64").includes(82),
      "foreground child must be ready",
    );
    for (const name of ["", "SIG", "not-a-signal", "0", "-1", "999999"]) {
      const invalid = await f.wire({
        op: "signal_session",
        uid: "signals",
        signal: name,
      });
      const reply = await invalid.next();
      assert.equal(reply.ok, false);
      assert.equal(reply.error_name, "InvalidSignal");
      await invalid.ended;
    }
    for (const [index, name] of [
      "usr1",
      String(constants.signals.SIGUSR1),
    ].entries()) {
      const reply = await f.request([
        "signal-session",
        "--uid",
        "signals",
        "--signal",
        name,
      ]);
      assert.equal(reply.session.exit_code, null);
      await eventually(
        () => f.read("signals"),
        (r) => {
          const text = Buffer.from(r.base64, "base64").toString();
          return (
            [...text].filter((c) => c === "P").length === index + 1 &&
            [...text].filter((c) => c === "F").length === index + 1
          );
        },
        "both process groups must receive the signal",
      );
    }
    await f.request([
      "signal-session",
      "--uid",
      "signals",
      "--signal",
      "SIGTERM",
    ]);
    const output = (await completion(stream, "signals", 23)).toString();
    assert.ok(output.includes("L") && output.includes("T"));
    const sibling = await f.request(["list-sessions"]);
    assert.deepEqual(
      sibling.sessions.map((s) => s.uid),
      ["keeper"],
    );
    await assert.rejects(
      f.cli(["signal-session", "--uid", "signals", "--signal", "SIGKILL"]),
      /UnknownUid/,
    );
    const victim = await f.wire({
      op: "new_session",
      uid: "killed",
      subscribe: true,
      argv: ["sleep", "120"],
      env: ["PATH=/usr/bin:/bin"],
      cwd: f.directory,
    });
    assert.equal((await victim.next()).event, "subscribed");
    await f.request([
      "signal-session",
      "--uid",
      "killed",
      "--signal",
      "sigkill",
    ]);
    assert.deepEqual(await completion(victim, "killed", 137), Buffer.alloc(0));
  },
);
