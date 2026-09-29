import assert from "node:assert/strict";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const status = (path) => readFile(path, "utf8").then(JSON.parse);

for (const isPty of [true, false]) {
  test(
    `durable ${isPty ? "PTY" : "pipe"} status preserves immediate output and exit seven without a subscriber`,
    linux,
    async (t) => {
      const f = await fixture(t);
      const path = join(f.directory, "status.json");
      const log = join(f.directory, "output.log");
      const reply = await f.request([
        "new-session",
        "--uid",
        "immediate",
        "--is-pty",
        String(isPty),
        "--status-path",
        path,
        "--log",
        log,
        "--",
        "/usr/bin/python3",
        "-c",
        "import os; os.write(1,b'immediate output'); os._exit(7)",
      ]);
      assert.ok(reply.session.pid > 0);
      assert.equal(reply.session.exit_code, null);
      const final = await eventually(
        () => status(path),
        (value) => value.session.exit_code === 7,
        "The daemon must persist exit seven",
      );
      assert.equal(final.ok, true);
      assert.equal(final.server_pid, reply.server_pid);
      assert.equal(final.error_name, null);
      assert.deepEqual(final.session, {
        ...reply.session,
        bytes: 16,
        exit_code: 7,
      });
      assert.equal(await readFile(log, "utf8"), "immediate output");
      await eventually(
        () => exists(`/proc/${reply.session.pid}`),
        (value) => !value,
        "The child must be reaped",
      );
      await eventually(
        () => exists(f.socket),
        (value) => !value,
        "The idle daemon must exit after persisting status",
      );
      assert.deepEqual(await status(path), final);
      assert.deepEqual(
        (await readdir(f.directory)).filter((name) => name.endsWith(".tmp")),
        [],
      );
    },
  );
}

test(
  "detached PTY and pipe sessions persist final status and clean inherited child groups after their launch clients exit",
  linux,
  async (t) => {
    const f = await fixture(t);
    const sessions = [];
    for (const isPty of [true, false]) {
      const uid = isPty ? "pty" : "pipe";
      const path = join(f.directory, `${uid}.json`);
      const log = join(f.directory, `${uid}.log`);
      const gate = join(f.directory, `${uid}.release`);
      const reply = await f.request([
        "new-session",
        "--uid",
        uid,
        "--is-pty",
        String(isPty),
        "--status-path",
        path,
        "--log",
        log,
        "--",
        "/usr/bin/python3",
        "-c",
        `import os,time
child=os.fork()
if child == 0:
    while True: time.sleep(1)
os.write(1,('child=%d\\n' % child).encode())
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.005)
os.write(1,b'completed')
os._exit(9)
`,
      ]);
      const initial = await status(path);
      assert.deepEqual(initial.session, reply.session);
      assert.equal(initial.session.exit_code, null);
      assert.equal(initial.session.bytes, 0);
      const ready = await eventually(
        () => readFile(log, "utf8"),
        (value) => /^child=\d+\r?\n$/.test(value),
        `${uid} must continue after the launching CLI exits`,
      );
      const descendant = Number(ready.match(/\d+/)[0]);
      assert.equal(await exists(`/proc/${descendant}`), true);
      assert.equal(await exists(`/proc/${reply.session.pid}`), true);
      sessions.push({ uid, path, log, gate, reply, descendant });
    }
    for (const session of sessions) {
      await writeFile(session.gate, "release");
      const final = await eventually(
        () => status(session.path),
        (value) => value.session.exit_code === 9,
        `${session.uid} must persist completion`,
      );
      assert.equal(final.session.pid, session.reply.session.pid);
      assert.equal(final.session.is_pty, session.reply.session.is_pty);
      assert.equal(final.session.bytes, (await readFile(session.log)).length);
      assert.ok((await readFile(session.log, "utf8")).endsWith("completed"));
      for (const pid of [session.reply.session.pid, session.descendant]) {
        await eventually(
          async () => {
            const state = await readFile(`/proc/${pid}/stat`, "utf8").catch(
              () => "",
            );
            return state && !state.includes(") Z ");
          },
          (alive) => !alive,
          "The completed session must stop its entire child group",
        );
      }
    }
    await eventually(
      () => exists(f.socket),
      (value) => !value,
      "The daemon must retire after both sessions finish",
    );
  },
);

test(
  "status destinations reject existing files and symlinks without launching or overwriting",
  linux,
  async (t) => {
    const f = await fixture(t);
    const existing = join(f.directory, "existing.json");
    const link = join(f.directory, "status-link");
    const marker = join(f.directory, "launched");
    await writeFile(existing, "preserve existing bytes");
    await symlink(existing, link);
    for (const path of [existing, link]) {
      await assert.rejects(
        f.cli([
          "new-session",
          "--uid",
          "rejected",
          "--status-path",
          path,
          "--",
          "/usr/bin/touch",
          marker,
        ]),
        /PathAlreadyExists/,
      );
      assert.equal(await readFile(existing, "utf8"), "preserve existing bytes");
      assert.equal(await exists(marker), false);
    }
    await f.request([
      "new-session",
      "--uid",
      "keeper",
      "--",
      "/bin/sh",
      "-c",
      "read value",
    ]);
    const relative = await f.wire({
      op: "new_session",
      uid: "relative",
      status_path: "relative.json",
      argv: ["/usr/bin/touch", marker],
      cwd: f.directory,
    });
    assert.equal((await relative.next()).error_name, "ExpectedAbsolutePath");
    const wrongOperation = await f.wire({
      op: "list_sessions",
      status_path: existing,
    });
    assert.equal((await wrongOperation.next()).error_name, "UnexpectedOption");
    assert.equal(await exists(marker), false);

    const rejectedSpawn = join(f.directory, "rejected-spawn.json");
    const invalidLaunch = await f.wire({
      op: "new_session",
      uid: "rejected-spawn",
      status_path: rejectedSpawn,
      cwd: f.directory,
      argv: [],
    });
    assert.equal((await invalidLaunch.next()).error_name, "InvalidArguments");
    assert.equal(await exists(rejectedSpawn), false);
    assert.deepEqual(
      (await readdir(f.directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  },
);

test(
  "failed final status replacement stops the daemon, cleans temporary files, and reaps sessions",
  linux,
  async (t) => {
    const f = await fixture(t);
    const path = join(f.directory, "status.json");
    const initialPath = join(f.directory, "initial.json");
    const gate = join(f.directory, "release");
    const target = await f.request([
      "new-session",
      "--uid",
      "failure",
      "--status-path",
      path,
      "--is-pty",
      "false",
      "--",
      "/usr/bin/python3",
      "-c",
      `import os,time
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.005)
os._exit(7)
`,
    ]);
    const sibling = await f.request([
      "new-session",
      "--uid",
      "sibling",
      "--",
      "/bin/sh",
      "-c",
      "read value",
    ]);
    await rename(path, initialPath);
    await mkdir(path);
    await writeFile(gate, "release");
    await eventually(
      () => exists(f.socket),
      (value) => !value,
      "An unwritable final status must fail the daemon instead of claiming completion",
    );
    assert.equal((await status(initialPath)).session.exit_code, null);
    assert.deepEqual(
      (await readdir(f.directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
    for (const pid of [target.session.pid, sibling.session.pid]) {
      await eventually(
        () => exists(`/proc/${pid}`),
        (value) => !value,
        "The failed daemon must reap every session",
      );
    }
  },
);

test(
  "native session and daemon termination persist final statuses without subscribers",
  linux,
  async (t) => {
    const f = await fixture(t);
    const sessions = [];
    for (const isPty of [true, false]) {
      const uid = `victim-${isPty}`;
      const path = join(f.directory, `${uid}.json`);
      const log = join(f.directory, `${uid}.log`);
      const reply = await f.request([
        "new-session",
        "--uid",
        uid,
        "--is-pty",
        String(isPty),
        "--status-path",
        path,
        "--log",
        log,
        "--",
        "/usr/bin/python3",
        "-c",
        "import os,time; os.write(1,b'ready'); time.sleep(120)",
      ]);
      await eventually(
        () => readFile(log, "utf8"),
        (value) => value === "ready",
        `${uid} must log output`,
      );
      sessions.push({ uid, path, reply });
    }
    await f.request(["kill-session", "--uid", sessions[0].uid]);
    const killed = await status(sessions[0].path);
    assert.equal(killed.session.exit_code, 137);
    assert.equal(killed.session.pid, sessions[0].reply.session.pid);
    assert.equal(killed.session.bytes, 5);
    assert.equal(killed.error_name, null);
    await f.request(["kill-server"]);
    const stopped = await eventually(
      () => status(sessions[1].path),
      (value) => value.session.exit_code === 137,
      "The daemon must persist terminated session status",
    );
    assert.equal(stopped.session.pid, sessions[1].reply.session.pid);
    assert.equal(stopped.session.bytes, 5);
    assert.equal(stopped.error_name, null);
    for (const session of sessions) {
      await eventually(
        () => exists(`/proc/${session.reply.session.pid}`),
        (value) => !value,
        "Native termination must reap the child",
      );
    }
  },
);
