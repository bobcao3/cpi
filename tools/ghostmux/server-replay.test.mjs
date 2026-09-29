import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { binary, eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 60000 };

test(
  "blocked subscriber output does not block control requests or session termination",
  linux,
  async (t) => {
    const f = await fixture(t);
    const gate = join(f.directory, "blocked-release");
    await launch(f, "blocked", 1, 0, gate, 16 * 1024 * 1024);
    const child = spawn(binary, [
      "-S",
      f.socket,
      "subscribe-output",
      "--uid",
      "blocked",
      "--json",
    ]);
    t.after(() => child.kill());
    const ended = new Promise((resolve) => child.once("exit", resolve));
    const reader = createInterface({ input: child.stdout });
    const lines = reader[Symbol.asyncIterator]();
    assert.equal(JSON.parse((await lines.next()).value).event, "subscribed");
    reader.close();
    child.stdout.pause();
    await writeFile(gate, "release");
    await eventually(
      async () =>
        (await f.request(["list-sessions"])).sessions.find(
          (session) => session.uid === "blocked",
        ),
      (session) => session?.bytes > 1024 * 1024,
      "The blocked subscriber must receive enough output to apply backpressure",
    );
    const start = Date.now();
    await f.request(["kill-session", "--uid", "blocked"]);
    assert.ok(
      Date.now() - start < 2000,
      "Session termination must not wait for the blocked subscriber",
    );
    child.kill();
    await ended;
  },
);

async function launch(f, uid, index, size, gate, afterSize = 0) {
  const pattern = Buffer.from([index, 0, 255, 65 + (index % 26), 10]);
  const before = Buffer.alloc(size, pattern);
  const afterPattern = Buffer.from([index + 16, 0, 255, 85, 10]);
  const after = afterSize
    ? Buffer.alloc(afterSize, afterPattern)
    : Buffer.from(`tail-${index}\n\0\xff`, "latin1");
  const path = join(f.directory, `${uid}.py`);
  await writeFile(
    path,
    `import os,time
pattern=bytes(${JSON.stringify([...pattern])})
data=(pattern*${Math.ceil(size / pattern.length)})[:${size}]
while data: data=data[os.write(1,data):]
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.005)
data=${afterSize ? `(bytes(${JSON.stringify([...afterPattern])})*${Math.ceil(afterSize / afterPattern.length)})[:${afterSize}]` : `bytes(${JSON.stringify([...after])})`}
while data: data=data[os.write(1,data):]
os._exit(${index % 7})
`,
  );
  await f.request([
    "new-session",
    "--uid",
    uid,
    "--is-pty",
    "false",
    "--",
    "python3",
    path,
  ]);
  await eventually(
    () => f.read(uid, 0, 1),
    (response) => response.session.bytes === size,
    `${uid} must retain the initial output`,
  );
  return { before, after, chunks: [], offset: 0, code: index % 7 };
}

function append(state, message) {
  assert.equal(message.ok, true, message.error_name);
  assert.equal(message.event, "data");
  assert.equal(message.offset, state.offset);
  const bytes = Buffer.from(message.base64, "base64");
  assert.ok(bytes.length > 0);
  state.offset += bytes.length;
  assert.equal(message.next_offset, state.offset);
  state.chunks.push(bytes);
}

function complete(state, message) {
  assert.equal(message.ok, true, message.error_name);
  assert.equal(message.eof, true);
  assert.equal(message.session.exit_code, state.code);
  assert.equal(message.offset, state.offset);
  assert.equal(message.next_offset, state.offset);
  assert.deepEqual(
    Buffer.concat(state.chunks),
    Buffer.concat([state.before, state.after]),
  );
}

test(
  "multiplex replay drains twenty-four full rings and orders concurrent final output before exits",
  linux,
  async (t) => {
    const f = await fixture(t);
    const gate = join(f.directory, "release");
    const sessions = new Map();
    for (let i = 0; i < 24; i++)
      sessions.set(
        `replay-${i}`,
        await launch(f, `replay-${i}`, i, 1024 * 1024, gate),
      );
    const stream = await f.wire({ op: "subscribe_output" });
    assert.equal((await stream.next()).event, "subscribed");
    await writeFile(gate, "release");
    for (let i = 0; i < 1200 && sessions.size > 0; i++) {
      const message = await stream.next();
      assert.equal(message.ok, true, message.error_name);
      const state = sessions.get(message.uid);
      assert.ok(state, `Unexpected session ${message.uid}`);
      if (message.event === "exit") {
        complete(state, message);
        sessions.delete(message.uid);
      } else append(state, message);
    }
    assert.equal(
      sessions.size,
      0,
      "Every session must deliver all retained and final bytes",
    );
    stream.close();
    await stream.ended;
  },
);

test(
  "shared live frames survive subscriber disconnects while remaining subscribers retain exact bytes",
  linux,
  async (t) => {
    const f = await fixture(t);
    const gate = join(f.directory, "release");
    const state = await launch(
      f,
      "fanout",
      3,
      256 * 1024,
      gate,
      2 * 1024 * 1024,
    );
    const streams = [];
    for (let i = 0; i < 24; i++) {
      const stream = await f.wire({ op: "subscribe_output", uid: "fanout" });
      assert.equal((await stream.next()).event, "subscribed");
      const copy = { ...state, chunks: [], offset: 0 };
      while (copy.offset < state.before.length)
        append(copy, await stream.next());
      streams.push({ stream, state: copy });
    }
    await writeFile(gate, "release");
    await Promise.all(
      streams.map(async ({ stream, state: copy }, index) => {
        for (let i = 0; i < 400; i++) {
          const message = await stream.next();
          if (message.event === "exit") {
            complete(copy, message);
            await stream.ended;
            return;
          }
          append(copy, message);
          if (index < 12) {
            stream.close();
            await stream.ended;
            return;
          }
        }
        assert.fail("A live subscriber must finish or disconnect");
      }),
    );
  },
);
