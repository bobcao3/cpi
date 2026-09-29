import assert from "node:assert/strict";
import { access, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import sharp from "sharp";
import { live, eventually, fixture } from "./server-fixture.mjs";

const linux = { skip: process.platform !== "linux", timeout: 30000 };

test(
  "concurrent clients auto-start one server and keep independent live terminals",
  linux,
  async (t) => {
    const f = await fixture(t);
    const replies = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        f.request([
          "new-session",
          "--uid",
          `job-${i}`,
          "--",
          "/bin/sh",
          "-c",
          `printf 'worker-${i}'; read value; exit ${i}`,
        ]),
      ),
    );
    assert.equal(new Set(replies.map((reply) => reply.server_pid)).size, 1);
    const list = await f.request(["list-sessions"]);
    assert.equal(list.sessions.length, 8);
    for (let i = 0; i < 8; i++) {
      const result = await live(f, `job-${i}`);
      assert.equal(result.text, `worker-${i}`);
      assert.equal(result.session.exit_code, null);
    }
    const marker = join(f.directory, "duplicate-ran");
    await assert.rejects(
      f.cli(["new-session", "--uid", "job-0", "--", "touch", marker]),
      /DuplicateUid/,
    );
    await assert.rejects(access(marker), { code: "ENOENT" });
  },
);

test(
  "new applications inherit the calling client's environment and cwd, with real PTYs",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request(
      ["new-session", "--uid", "first", "--", "/bin/sh", "-c", "read value"],
      {
        env: { ...process.env, TC_MARKER: "first" },
      },
    );
    const cwd = join(f.directory, "second");
    await mkdir(cwd);
    const exported = "() { printf inherited; }";
    const program =
      "import os,json; print(json.dumps([os.getcwd(),os.environ['TC_MARKER'],[os.isatty(n) for n in range(3)],os.environ['TERM'],os.environ['BASH_FUNC_tc_probe%%']]),flush=True); input()";
    await f.request(
      [
        "new-session",
        "--uid",
        "second",
        "--cols",
        "300",
        "--",
        "python3",
        "-c",
        program,
      ],
      {
        cwd,
        env: {
          ...process.env,
          TC_MARKER: "second",
          "BASH_FUNC_tc_probe%%": exported,
        },
      },
    );
    const result = await live(f, "second");
    assert.deepEqual(JSON.parse(result.text), [
      cwd,
      "second",
      [true, true, true],
      "xterm-256color",
      exported,
    ]);
  },
);

test(
  "CLI input, resize notifications, and terminal query replies reach the application",
  linux,
  async (t) => {
    const f = await fixture(t);
    const program = `import os,signal,sys

def report(*args):
    size=os.get_terminal_size(0)
    print('SIZE %d %d' % (size.columns,size.lines),flush=True)

signal.signal(signal.SIGWINCH,report)
report()
for line in sys.stdin:
    print('GOT:'+line.rstrip(),flush=True)
`;
    await f.request([
      "new-session",
      "--uid",
      "interactive",
      "--cols",
      "31",
      "--rows",
      "8",
      "--",
      "python3",
      "-c",
      program,
    ]);
    await eventually(
      () => f.capture("interactive"),
      (value) => value.text.includes("SIZE 31 8"),
      "initial PTY geometry",
    );
    await f.request([
      "resize-window",
      "--uid",
      "interactive",
      "--cols",
      "47",
      "--rows",
      "11",
    ]);
    const resized = await eventually(
      () => f.capture("interactive"),
      (value) => value.text.includes("SIZE 47 11"),
      "SIGWINCH and new PTY geometry",
    );
    assert.equal(resized.session.cols, 47);
    assert.equal(resized.session.rows, 11);
    await f.request([
      "send-input",
      "--uid",
      "interactive",
      "--text",
      "hello\n",
    ]);
    await eventually(
      () => f.capture("interactive"),
      (value) => value.text.includes("GOT:hello"),
      "input must reach the PTY",
    );
    const query = `import os,tty,fcntl,termios,struct,json
tty.setraw(0)
def query(sequence,end):
    os.write(1,sequence)
    reply=b''
    for _ in range(128):
        reply+=os.read(0,1)
        if reply.endswith(end): return reply.decode()
    raise Exception('unterminated reply')
position=query(b'\\x1b[6n',b'R')
pixels=query(b'\\x1b[16t',b't')
size=struct.unpack('HHHH',fcntl.ioctl(0,termios.TIOCGWINSZ,b'\\0'*8))
os.write(1,(json.dumps([position,pixels,size])+'\\r\\n').encode())
os.read(0,1)
`;
    await f.request([
      "new-session",
      "--uid",
      "query",
      "--cols",
      "200",
      "--rows",
      "4",
      "--",
      "python3",
      "-c",
      query,
    ]);
    const result = await live(f, "query");
    const [position, pixels, size] = JSON.parse(result.text);
    assert.equal(position, "\x1b[1;1R");
    const match = pixels.match(/^\x1b\[6;(\d+);(\d+)t$/);
    assert.ok(match, pixels);
    const path = join(f.directory, "query.png");
    await f.request(["screenshot", "--uid", "query", "--output", path]);
    const image = await sharp(path).metadata();
    assert.equal(Number(match[1]), image.height / 4);
    assert.equal(Number(match[2]), image.width / 200);
    assert.deepEqual(size, [4, 200, image.width, image.height]);
  },
);

test(
  "server screenshots use the selected UID and client-relative output path",
  linux,
  async (t) => {
    const f = await fixture(t);
    await f.request([
      "new-session",
      "--uid",
      "screen",
      "--cols",
      "20",
      "--rows",
      "4",
      "--",
      "python3",
      "-c",
      "print('\\x1b[?25l\\x1b[31m中文 😀\\x1b[0m',flush=True); input()",
    ]);
    const captured = await live(f, "screen");
    assert.equal(captured.text, "中文 😀");
    const shot = await f.request(
      ["screenshot", "--uid", "screen", "--output", "frame.png"],
      { cwd: f.directory },
    );
    assert.equal(shot.path, join(f.directory, "frame.png"));
    const metadata = await sharp(shot.path).metadata();
    assert.equal(metadata.format, "png");
    assert.equal(metadata.width % 20, 0);
    assert.equal(metadata.height % 4, 0);
    assert.ok((await readFile(shot.path)).length > 100);
    const pixels = await sharp(shot.path).removeAlpha().raw().toBuffer();
    await f.request([
      "new-session",
      "--uid",
      "other-screen",
      "--cols",
      "20",
      "--rows",
      "4",
      "--",
      "python3",
      "-c",
      "print('\\x1b[?25l\\x1b[32mSECOND',flush=True); input()",
    ]);
    await live(f, "other-screen");
    const other = await f.request([
      "screenshot",
      "--uid",
      "other-screen",
      "--output",
      join(f.directory, "other.png"),
    ]);
    assert.notDeepEqual(
      await sharp(other.path).removeAlpha().raw().toBuffer(),
      pixels,
    );
    await f.request(["screenshot", "--uid", "screen", "--output", shot.path]);
    assert.deepEqual(
      await sharp(shot.path).removeAlpha().raw().toBuffer(),
      pixels,
    );
    const plain = await f.cli(["capture-pane", "--uid", "screen"]);
    assert.equal(plain.stdout, "中文 😀\n");
  },
);
