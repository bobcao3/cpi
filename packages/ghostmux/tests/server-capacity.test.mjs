import assert from "node:assert/strict";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 60000 };

test(
  "twenty-four observed PTY and pipe launches retain independent output and tear down children",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request([
      "new-session",
      "--uid",
      "bootstrap",
      "--",
      "/bin/sh",
      "-c",
      "read value",
    ]);
    const sessions = [];
    for (let index = 0; index < 24; index++) {
      const uid = `observed-${index}`;
      const isPty = index % 2 === 0;
      const gate = join(f.directory, uid);
      const stream = await f.wire({
        op: "new_session",
        uid,
        subscribe: true,
        is_pty: isPty,
        cwd: f.directory,
        argv: [
          "/usr/bin/python3",
          "-c",
          `import os,time
if os.isatty(0):
    import tty
    tty.setraw(0)
os.write(1,b'${uid} ready\\n')
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.005)
os.write(1,b'${uid} final\\n')
while True: time.sleep(1)
`,
        ],
      });
      const ack = await stream.next();
      assert.equal(ack.ok, true, ack.error_name);
      assert.equal(ack.event, "subscribed");
      assert.equal(ack.uid, uid);
      assert.equal(ack.session.is_pty, isPty);
      const ready = await stream.next();
      assert.equal(ready.event, "data");
      assert.equal(ready.uid, uid);
      assert.equal(ready.offset, 0);
      assert.equal(
        Buffer.from(ready.base64, "base64").toString(),
        `${uid} ready\n`,
      );
      sessions.push({
        uid,
        isPty,
        gate,
        stream,
        pid: ack.session.pid,
        offset: ready.next_offset,
      });
    }
    const listed = (await f.request(["list-sessions"])).sessions;
    assert.equal(listed.length, 25);
    assert.deepEqual(
      new Set(listed.map((session) => session.uid)),
      new Set(["bootstrap", ...sessions.map((session) => session.uid)]),
    );
    await f.request(["kill-session", "--uid", "bootstrap"]);
    for (const session of sessions) {
      const output = await f.read(session.uid);
      assert.equal(
        Buffer.from(output.base64, "base64").toString(),
        `${session.uid} ready\n`,
      );
      if (session.isPty) {
        assert.equal(
          (await f.capture(session.uid)).text,
          `${session.uid} ready`,
        );
      }
    }
    for (const session of sessions.slice(0, 8)) session.stream.close();
    await Promise.all(
      sessions.slice(0, 8).map((session) => session.stream.ended),
    );
    await Promise.all(
      sessions.map((session) => writeFile(session.gate, "release")),
    );
    for (const session of sessions.slice(8)) {
      const output = await session.stream.next();
      assert.equal(output.event, "data");
      assert.equal(output.uid, session.uid);
      assert.equal(output.offset, session.offset);
      assert.equal(
        Buffer.from(output.base64, "base64").toString(),
        `${session.uid} final\n`,
      );
      session.offset = output.next_offset;
    }
    for (const session of sessions.slice(0, 12)) {
      await f.request(["kill-session", "--uid", session.uid]);
    }
    assert.equal((await f.request(["list-sessions"])).sessions.length, 12);
    await f.request(["kill-server"]);
    for (const session of sessions.slice(8)) {
      const exit = await session.stream.next();
      assert.equal(exit.event, "exit");
      assert.equal(exit.uid, session.uid);
      assert.equal(exit.session.exit_code, 137);
      assert.equal(exit.offset, session.offset);
      assert.equal(exit.eof, true);
      await session.stream.ended;
    }
    for (const session of sessions) {
      await eventually(
        () =>
          access(`/proc/${session.pid}`).then(
            () => true,
            () => false,
          ),
        (exists) => !exists,
        `${session.uid} child must be reaped`,
      );
    }
    await eventually(
      () =>
        access(f.socket).then(
          () => true,
          () => false,
        ),
      (exists) => !exists,
      "The server must remove the socket after shutdown",
    );
  },
);
