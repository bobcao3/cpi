import assert from "node:assert/strict";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };

function output(messages, uid, code) {
  const chunks = [];
  let offset = 0;
  const exit = messages.pop();
  for (const message of messages) {
    assert.equal(message.ok, true, message.error_name);
    assert.equal(message.event, "data");
    assert.equal(message.uid, uid);
    assert.equal(message.offset, offset);
    const chunk = Buffer.from(message.base64, "base64");
    offset += chunk.length;
    assert.equal(message.next_offset, offset);
    chunks.push(chunk);
  }
  assert.equal(exit.ok, true, exit.error_name);
  assert.equal(exit.event, "exit");
  assert.equal(exit.uid, uid);
  assert.equal(exit.session.is_pty, false);
  assert.equal(exit.session.exit_code, code);
  assert.equal(exit.offset, offset);
  assert.equal(exit.next_offset, offset);
  assert.equal(exit.eof, true);
  return Buffer.concat(chunks);
}

async function finish(stream, uid, code) {
  const messages = [];
  for (let i = 0; i < 1000; i++) {
    const message = await stream.next();
    messages.push(message);
    if (message.event === "exit") {
      await stream.ended;
      return output(messages, uid, code);
    }
    assert.equal(message.event, "data", message.error_name);
  }
  assert.fail("pipe session must finish within 1000 frames");
}

test(
  "CLI pipe launch preserves binary stdout/stderr, environment, and stdin EOF",
  linux,
  async (t) => {
    const f = await fixture(t);
    const log = join(f.directory, "pipe.log");
    const program = `import os,stat,json
assert not any(os.isatty(fd) for fd in (0,1,2))
assert all(stat.S_ISFIFO(os.fstat(fd).st_mode) for fd in (1,2))
assert os.fstat(1).st_ino==os.fstat(2).st_ino
assert os.read(0,1)==b''
os.write(1,json.dumps({name:os.environ.get(name) for name in ('TERM','COLORTERM','TERM_PROGRAM')}).encode()+b'\\n')
os.write(2,b'stderr\\n\\x1b[6n')
data=bytes(range(256))*8192
while data: data=data[os.write(1,data):]
os._exit(19)
`;
    const result = await f.cli(
      [
        "new-session",
        "--uid",
        "pipes",
        "--is-pty",
        "false",
        "--subscribe",
        "--json",
        "--log",
        log,
        "--",
        "python3",
        "-c",
        program,
      ],
      {
        env: {
          ...process.env,
          TERM: "preserved-term",
          COLORTERM: "preserved-color",
          TERM_PROGRAM: "preserved-program",
        },
      },
    );
    const messages = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const first = messages.shift();
    assert.equal(first.event, "subscribed");
    assert.equal(first.session.is_pty, false);
    assert.equal(first.session.cols, 0);
    assert.equal(first.session.rows, 0);
    const bytes = output(messages, "pipes", 19);
    const newline = bytes.indexOf(10);
    assert.deepEqual(JSON.parse(bytes.subarray(0, newline)), {
      TERM: "preserved-term",
      COLORTERM: "preserved-color",
      TERM_PROGRAM: "preserved-program",
    });
    const pattern = Buffer.from(
      Array.from({ length: 256 }, (_, index) => index),
    );
    assert.deepEqual(
      bytes.subarray(newline + 1),
      Buffer.concat([
        Buffer.from("stderr\n\x1b[6n"),
        ...Array(8192).fill(pattern),
      ]),
    );
    assert.deepEqual(await readFile(log), bytes);
  },
);

test(
  "wire pipe sessions use caller PATH/cwd, reject terminal commands, and support reconnect and signals",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request(["new-session", "--uid", "keeper", "--", "sleep", "120"]);
    const script = join(f.directory, "pipe-command");
    const gate = join(f.directory, "release");
    const program = `#!/usr/bin/python3
import os,time,signal,json
signal.signal(signal.SIGUSR1,lambda *_: os.write(2,b'noticed\\n'))
assert os.read(0,1)==b''
assert os.getcwd()==${JSON.stringify(f.directory)}
assert all(name not in os.environ for name in ('TERM','COLORTERM','TERM_PROGRAM'))
assert os.environ['ZIG_PROGRESS']=='verbatim'
os.write(1,b'ready\\n')
while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)
os.write(2,b'final\\n')
os._exit(7)
`;
    await writeFile(script, program);
    await chmod(script, 0o700);
    const launch = await f.wire({
      op: "new_session",
      uid: "wire-pipe",
      is_pty: false,
      subscribe: true,
      argv: ["pipe-command"],
      env: ["PATH=.", "ZIG_PROGRESS=verbatim"],
      cwd: f.directory,
    });
    const first = await launch.next();
    assert.equal(first.event, "subscribed");
    assert.equal(first.session.is_pty, false);
    await eventually(
      () => f.read("wire-pipe"),
      (reply) => reply.next_offset === 6,
      "pipe output must be ready",
    );
    launch.close();
    await launch.ended;
    const read = await f.read("wire-pipe", 2, 3);
    assert.equal(Buffer.from(read.base64, "base64").toString(), "ady");
    const reconnect = await f.wire({
      op: "subscribe_output",
      uid: "wire-pipe",
      offset: 0,
    });
    assert.equal((await reconnect.next()).event, "subscribed");
    for (const args of [
      ["capture-pane", "--uid", "wire-pipe"],
      [
        "screenshot",
        "--uid",
        "wire-pipe",
        "--output",
        join(f.directory, "no.png"),
      ],
      ["resize-window", "--uid", "wire-pipe", "--cols", "100", "--rows", "30"],
      ["send-input", "--uid", "wire-pipe", "--text", "input"],
    ])
      await assert.rejects(f.cli(args), /NotPty/);
    await f.request([
      "signal-session",
      "--uid",
      "wire-pipe",
      "--signal",
      "USR1",
    ]);
    await eventually(
      () => f.read("wire-pipe"),
      (reply) => reply.next_offset === 14,
      "stderr signal handler must drain",
    );
    await writeFile(gate, "release");
    assert.equal(
      (await finish(reconnect, "wire-pipe", 7)).toString(),
      "ready\nnoticed\nfinal\n",
    );
    const next = await f.request([
      "new-session",
      "--uid",
      "wire-pipe",
      "--is-pty",
      "false",
      "--",
      "sleep",
      "120",
    ]);
    const handles = () => readdir(`/proc/${first.server_pid}/fd`);
    const baseline = (await handles()).length;
    const children = async () => {
      const threads = await readdir(`/proc/${first.server_pid}/task`);
      const lists = await Promise.all(
        threads.map((thread) =>
          readFile(
            `/proc/${first.server_pid}/task/${thread}/children`,
            "utf8",
          ).catch(() => ""),
        ),
      );
      return new Set(lists.join(" ").trim().split(/\s+/).filter(Boolean)).size;
    };
    const children_before = await children();
    for (let attempt = 0; attempt < 12; attempt++) {
      const failed = await f.wire({
        op: "new_session",
        uid: "failed",
        is_pty: false,
        subscribe: true,
        argv: [join(f.directory, "missing-executable")],
        env: [],
        cwd: f.directory,
      });
      const reply = await failed.next();
      if (reply.event === "subscribed") {
        assert.deepEqual(await finish(failed, "failed", 127), Buffer.alloc(0));
      } else {
        assert.equal(reply.ok, false);
        assert.equal(reply.error_name, "FileNotFound");
        await failed.ended;
      }
    }
    await eventually(
      handles,
      (value) => value.length <= baseline,
      "failed pipe launches must close handles",
    );
    await eventually(
      children,
      (count) => count <= children_before,
      "failed pipe launches must reap children",
    );
    assert.equal(next.session.is_pty, false);
    const running = await f.request(["list-sessions"]);
    assert.equal(
      running.sessions.find((s) => s.uid === "wire-pipe").is_pty,
      false,
    );
    assert.equal(running.sessions.find((s) => s.uid === "keeper").is_pty, true);
    await f.request(["kill-session", "--uid", "wire-pipe"]);
    await assert.rejects(f.read("wire-pipe"), /UnknownUid/);
  },
);

test(
  "pipe group termination reaches descendants and leader exit bounds inherited-pipe drainage",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request(["new-session", "--uid", "keeper", "--", "sleep", "120"]);
    const gate = join(f.directory, "leader-release");
    const program = `import os,time,signal
signal.signal(signal.SIGHUP,signal.SIG_IGN)
child=os.fork()
if child==0:
    os.write(2,('child:'+str(os.getpid())+'\\n').encode())
    time.sleep(120)
else:
    while not os.path.exists(${JSON.stringify(gate)}): time.sleep(0.01)
    os.write(1,b'leader-final\\n')
    os._exit(5)
`;
    for (const mode of ["kill", "exit"]) {
      const stream = await f.wire({
        op: "new_session",
        uid: mode,
        is_pty: false,
        subscribe: true,
        argv: ["python3", "-c", program],
        env: ["PATH=/usr/bin:/bin"],
        cwd: f.directory,
      });
      assert.equal((await stream.next()).event, "subscribed");
      const reply = await eventually(
        () => f.read(mode),
        (value) =>
          /child:\d+/.test(Buffer.from(value.base64, "base64").toString()),
        "descendant must be ready",
      );
      const child = Number(
        Buffer.from(reply.base64, "base64")
          .toString()
          .match(/child:(\d+)/)[1],
      );
      t.after(async () => {
        const command = await readFile(`/proc/${child}/cmdline`, "utf8").catch(
          () => "",
        );
        if (command.includes(gate)) {
          try {
            process.kill(child, "SIGKILL");
          } catch {}
        }
      });
      if (mode === "kill") {
        await f.request([
          "signal-session",
          "--uid",
          mode,
          "--signal",
          "SIGKILL",
        ]);
        await finish(stream, mode, 137);
        await eventually(
          async () => {
            const stat = await readFile(`/proc/${child}/stat`, "utf8").catch(
              () => "",
            );
            return stat === "" || stat.split(") ")[1]?.startsWith("Z");
          },
          Boolean,
          "pipe descendant group must terminate",
        );
      } else {
        await writeFile(gate, "release");
        assert.match(
          (await finish(stream, mode, 5)).toString(),
          /leader-final\n$/,
        );
        const sibling = await f.request(["list-sessions"]);
        assert.deepEqual(
          sibling.sessions.map((s) => s.uid),
          ["keeper"],
        );
      }
    }
  },
);
