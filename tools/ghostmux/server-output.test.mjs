import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { binary, eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };
const initial = Buffer.concat([
  Buffer.from("\x1b[31m中文\x1b[0m"),
  Buffer.from([0, 1, 127, 128, 255, 13, 10]),
]);
const final = Buffer.alloc(
  2 * 1024 * 1024,
  Buffer.from([70, 73, 78, 65, 76, 0, 255]),
);

function application(before, after = Buffer.alloc(0), code = 0) {
  return `import os,tty,base64
 tty.setraw(0)
 def emit(encoded):
     data=base64.b64decode(encoded)
     while data:
         data=data[os.write(1,data):]
 emit('${before.toString("base64")}')
 os.read(0,1)
 emit('${after.toString("base64")}')
 os._exit(${code})
`.replace(/^ /gm, "");
}

async function start(f, uid, before, after, code, extra = []) {
  const path = join(f.directory, `${uid}.py`);
  await writeFile(path, application(before, after, code));
  return f.request([
    "new-session",
    "--uid",
    uid,
    ...extra,
    "--",
    "python3",
    path,
  ]);
}

async function ready(f, uid, length) {
  return eventually(
    () => f.read(uid),
    (reply) => reply.next_offset === length,
    `${uid} initial bytes must drain`,
  );
}

function data(response, uid, offset) {
  assert.equal(response.ok, true);
  assert.equal(response.uid, uid);
  assert.equal(response.offset, offset);
  const bytes = Buffer.from(response.base64, "base64");
  assert.equal(response.next_offset, offset + bytes.length);
  assert.ok(bytes.length <= 65536);
  return bytes;
}

async function finish(subscription, uid, code, offset = 0) {
  const chunks = [];
  for (let i = 0; i < 1000; i++) {
    const response = await subscription.next();
    if (response.event === "exit") {
      assert.equal(response.uid, uid);
      assert.equal(response.eof, true);
      assert.equal(response.session.exit_code, code);
      assert.equal(response.offset, offset);
      assert.equal(response.next_offset, offset);
      return Buffer.concat(chunks);
    }
    assert.equal(response.event, "data", response.error_name);
    const bytes = data(response, uid, offset);
    assert.ok(bytes.length > 0);
    chunks.push(bytes);
    offset += bytes.length;
  }
  assert.fail("subscription must finish within 1000 frames");
}

async function release(f, uid) {
  await f.request(["send-input", "--uid", uid, "--text", "x"]);
}

test(
  "reconnect reads and subscribed final output preserve byte offsets and exact raw logs",
  linux,
  async (t) => {
    const f = await fixture(t);
    const log = join(f.directory, "raw.log");
    await start(f, "binary", initial, final, 9, ["--log", log]);
    const replay = await ready(f, "binary", initial.length);
    assert.equal(replay.eof, false);
    assert.deepEqual(data(replay, "binary", 0), initial);
    const reader = await f.wire({
      op: "read_output",
      uid: "binary",
      offset: 2,
      limit: 5,
    });
    const partial = await reader.next();
    assert.deepEqual(data(partial, "binary", 2), initial.subarray(2, 7));
    assert.equal(partial.eof, false);
    await reader.ended;
    const chunks = [];
    let offset = 0;
    while (offset < initial.length) {
      const response = await f.read("binary", offset, 3);
      assert.equal(response.eof, false);
      const bytes = data(response, "binary", offset);
      assert.ok(bytes.length > 0 && bytes.length <= 3);
      chunks.push(bytes);
      offset = response.next_offset;
    }
    assert.deepEqual(Buffer.concat(chunks), initial);
    const end = await f.read("binary", offset);
    assert.deepEqual(data(end, "binary", offset), Buffer.alloc(0));
    assert.equal(end.eof, false);
    await assert.rejects(
      f.cli(["read-output", "--uid", "binary", "--offset", String(offset + 1)]),
      /InvalidOffset/,
    );
    const plain = await f.cli(["read-output", "--uid", "binary"], {
      encoding: "buffer",
    });
    assert.deepEqual(plain.stdout, initial);
    const disconnected = await f.wire({
      op: "subscribe_output",
      uid: "binary",
      offset: 0,
    });
    assert.equal((await disconnected.next()).event, "subscribed");
    assert.deepEqual(data(await disconnected.next(), "binary", 0), initial);
    disconnected.close();
    await disconnected.ended;
    const subscription = await f.wire({
      op: "subscribe_output",
      uid: "binary",
      offset,
    });
    assert.equal((await subscription.next()).event, "subscribed");
    await release(f, "binary");
    assert.deepEqual(await finish(subscription, "binary", 9, offset), final);
    await subscription.ended;
    assert.deepEqual(await readFile(log), Buffer.concat([initial, final]));
  },
);

test(
  "multiplex subscriptions replay current sessions, include future sessions, and permit UID reuse",
  linux,
  async (t) => {
    const f = await fixture(t);
    await start(
      f,
      "old",
      Buffer.from("old-before"),
      Buffer.from("old-after"),
      4,
    );
    await ready(f, "old", 10);
    const stream = await f.wire({
      op: "subscribe_output",
      uid: null,
      offset: 0,
    });
    assert.equal((await stream.next()).event, "subscribed");
    assert.deepEqual(
      data(await stream.next(), "old", 0),
      Buffer.from("old-before"),
    );
    await start(
      f,
      "future",
      Buffer.from("new-before"),
      Buffer.from("new-after"),
      5,
    );
    assert.deepEqual(
      data(await stream.next(), "future", 0),
      Buffer.from("new-before"),
    );
    await release(f, "old");
    assert.deepEqual(
      await finish(stream, "old", 4, 10),
      Buffer.from("old-after"),
    );
    await assert.rejects(f.capture("old"), /UnknownUid/);
    await assert.rejects(
      f.request([
        "screenshot",
        "--uid",
        "old",
        "--output",
        join(f.directory, "expired.png"),
      ]),
      /UnknownUid/,
    );
    await assert.rejects(f.read("old"), /UnknownUid/);
    assert.deepEqual(
      (await f.request(["list-sessions"])).sessions.map(
        (session) => session.uid,
      ),
      ["future"],
    );
    await release(f, "future");
    assert.deepEqual(
      await finish(stream, "future", 5, 10),
      Buffer.from("new-after"),
    );
    assert.deepEqual((await f.request(["list-sessions"])).sessions, []);
    for (let i = 0; i < 20; i++) {
      const bytes = Buffer.from(`reuse-${i}`);
      await start(f, "old", bytes, Buffer.alloc(0), 0);
      assert.deepEqual(data(await stream.next(), "old", 0), bytes);
      await release(f, "old");
      assert.deepEqual(
        await finish(stream, "old", 0, bytes.length),
        Buffer.alloc(0),
      );
    }
    const shutdown = Buffer.from("shutdown");
    await start(f, "shutdown", shutdown, Buffer.alloc(0), 0);
    assert.deepEqual(data(await stream.next(), "shutdown", 0), shutdown);
    await f.request(["kill-server"]);
    assert.deepEqual(
      await finish(stream, "shutdown", 137, shutdown.length),
      Buffer.alloc(0),
    );
    await stream.ended;
    await assert.rejects(stream.next(), /wire socket ended/);
    await eventually(
      () =>
        access(f.socket).then(
          () => true,
          () => false,
        ),
      (present) => !present,
      "server shutdown must close multiplex clients and unlink the socket",
    );
  },
);

test(
  "expired ring offsets fail while a tail subscription replays retained bytes",
  linux,
  async (t) => {
    const f = await fixture(t);
    const bytes = Buffer.from("0123456789abcdef".repeat(131072));
    await f.request([
      "new-session",
      "--uid",
      "ring",
      "--",
      "python3",
      "-c",
      "import os,tty; tty.setraw(0); data=b'0123456789abcdef'*131072\nwhile data: data=data[os.write(1,data):]\nos.read(0,1); os.write(1,b'tail')",
    ]);
    await eventually(
      () => f.capture("ring"),
      (reply) => reply.session.bytes === bytes.length,
      "large PTY output must drain",
    );
    await assert.rejects(f.read("ring", 0), /OutputExpired/);
    const offset = bytes.length - 65536;
    const tail = await f.read("ring", offset);
    assert.deepEqual(data(tail, "ring", offset), bytes.subarray(offset));
    const stream = await f.wire({
      op: "subscribe_output",
      uid: "ring",
      offset,
    });
    assert.equal((await stream.next()).event, "subscribed");
    assert.deepEqual(
      data(await stream.next(), "ring", offset),
      bytes.subarray(offset),
    );
    await release(f, "ring");
    assert.deepEqual(
      await finish(stream, "ring", 0, bytes.length),
      Buffer.from("tail"),
    );
  },
);

test(
  "CLI JSON subscriptions emit replay before final data and exit",
  linux,
  async (t) => {
    const f = await fixture(t);
    await start(f, "cli", initial, Buffer.from("done"), 3);
    await ready(f, "cli", initial.length);
    const child = spawn(binary, [
      "-S",
      f.socket,
      "subscribe-output",
      "--uid",
      "cli",
      "--offset",
      "0",
      "--json",
    ]);
    t.after(() => child.kill());
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    const stream = {
      async next() {
        const line = await lines.next();
        assert.equal(line.done, false, stderr);
        return JSON.parse(line.value);
      },
    };
    assert.equal((await stream.next()).event, "subscribed");
    assert.deepEqual(data(await stream.next(), "cli", 0), initial);
    await release(f, "cli");
    assert.deepEqual(
      await finish(stream, "cli", 3, initial.length),
      Buffer.from("done"),
    );
    assert.equal(await exited, 0, stderr);
  },
);
