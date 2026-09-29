import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";

const binary =
  process.env.GHOSTMUX_BIN ??
  fileURLToPath(new URL("./zig-out/bin/ghostmux", import.meta.url));

function raw(data, args = []) {
  const result = spawnSync(binary, args, {
    cwd: tmpdir(),
    input: data,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    result.stderr?.toString() || String(result.error),
  );
  return result.stdout.toString();
}

async function client(t, cols = 20, rows = 4) {
  const child = spawn(
    binary,
    ["--protocol", "--cols", String(cols), "--rows", String(rows)],
    { cwd: tmpdir() },
  );
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  t.after(() => child.kill());
  return {
    async request(request) {
      child.stdin.write(JSON.stringify(request) + "\n");
      const line = await lines.next();
      assert.equal(line.done, false, stderr);
      const response = JSON.parse(line.value);
      assert.equal(response.ok, true);
      return response;
    },
    async close() {
      await this.request({ op: "quit" });
      child.stdin.end();
      assert.equal(await exit, 0, stderr);
    },
  };
}

test(
  "raw input preserves PTY carriage returns, terminal edits, and Unicode",
  { skip: process.platform === "win32", timeout: 20000 },
  () => {
    const source = String.raw`
import errno, os, pty, subprocess, sys
master, slave = pty.openpty()
child = subprocess.Popen([sys.executable, '-c', 'import sys; sys.stdout.write("old status\\r\\x1b[2Kdone\\n中文 😀 e\\u0301\\n")'.replace('\\\\', '\\')], stdout=slave, stderr=slave)
os.close(slave)
while True:
    try:
        data = os.read(master, 4096)
        if not data: break
        sys.stdout.buffer.write(data)
    except OSError as error:
        if error.errno != errno.EIO: raise
        break
os.close(master)
sys.exit(child.wait())
`;
    const pty = spawnSync("python3", ["-c", source], { timeout: 10000 });
    assert.equal(pty.status, 0, pty.stderr.toString());
    assert.equal(raw(pty.stdout), "done\n中文 😀 é\n");
  },
);

test(
  "ordered snapshots retain parser state, isolate alternate screens, and resize",
  { timeout: 30000 },
  async (t) => {
    const cli = await client(t, 8, 3);
    const bytes = Buffer.from(
      "\x1b]2;split title\x1b\\\x1bP$qm\x1b\\\x1b[31m中é\x1b[0m",
    );
    for (const byte of bytes)
      await cli.request({
        op: "feed",
        base64: Buffer.from([byte]).toString("base64"),
      });
    assert.equal((await cli.request({ op: "capture" })).text, "中é");
    await cli.request({
      op: "feed",
      data: "\x1b[?1049h\x1b[2J\x1b[Halternate",
    });
    assert.equal(
      (await cli.request({ op: "capture", join: true })).text,
      "alternate",
    );
    await cli.request({ op: "feed", data: "\x1b[?1049l" });
    assert.equal((await cli.request({ op: "capture" })).text, "中é");
    await cli.request({ op: "feed", data: "\r\nline2\r\nline3\r\nline4" });
    assert.equal(
      (await cli.request({ op: "capture" })).text,
      "line2\nline3\nline4",
    );
    assert.equal(
      (await cli.request({ op: "capture", history: true })).text,
      "中é\nline2\nline3\nline4",
    );
    const resized = await cli.request({ op: "resize", cols: 12, rows: 5 });
    assert.equal(resized.cols, 12);
    assert.equal(resized.rows, 5);
    assert.equal(
      (await cli.request({ op: "capture", history: true })).text,
      "中é\nline2\nline3\nline4",
    );
    await cli.close();
  },
);

test("text capture distinguishes physical rows from soft wrapping", () => {
  const data = "abcdefghijk\r\nend";
  assert.equal(
    raw(data, ["--cols", "5", "--rows", "6"]),
    "abcde\nfghij\nk\nend\n",
  );
  assert.equal(
    raw(data, ["--cols", "5", "--rows", "6", "--join"]),
    "abcdefghijk\nend\n",
  );
});

test(
  "screenshots render fallback glyphs, colors, and changed state without external fonts",
  { timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ghostmux-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const cli = await client(t, 24, 6);
    await cli.request({
      op: "feed",
      data: "\x1b[?25l\x1b]11;#102030\x1b\\\x1b[38;2;240;80;20m\x1b[48;2;7;11;17mA\x1b[0m\r\n中文 日本 한글\r\n😀 🚀 ❤️\r\n\uf120 \uf09b \ue0b0\r\né ≠ ┌─┐\x1b[5;11H\x1b[3mW\x1b[0m\r\n口",
    });
    const path = join(directory, "first.png");
    await cli.request({
      op: "feed",
      data: Array.from({ length: 6 }, (_, y) => `\x1b[${y + 1};24H│`).join(""),
    });
    await cli.request({ op: "screenshot", path });
    const { data, info } = await sharp(path)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(info.width % 24, 0);
    assert.equal(info.height % 6, 0);
    const cellWidth = info.width / 24;
    const cellHeight = info.height / 6;
    assert.deepEqual([...data.subarray(0, 3)], [7, 11, 17]);
    assert.deepEqual([...data.subarray(-3)], [16, 32, 48]);
    const pixel = (x, y) =>
      [
        ...data.subarray(
          (y * info.width + x) * 3,
          (y * info.width + x) * 3 + 3,
        ),
      ].join(",");
    for (let y = 0; y < info.height; y++) {
      assert.notEqual(
        pixel(23 * cellWidth + Math.floor(cellWidth / 2), y),
        "16,32,48",
        `Box-drawing cells must join at scanline ${y}`,
      );
    }
    for (const [row, column, width] of [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [1, 5, 2],
      [1, 10, 2],
      [2, 0, 2],
      [2, 3, 2],
      [3, 0, 1],
      [3, 2, 1],
      [3, 4, 1],
      [4, 0, 1],
    ]) {
      const colors = new Set();
      for (let y = row * cellHeight; y < (row + 1) * cellHeight; y++) {
        for (let x = column * cellWidth; x < (column + width) * cellWidth; x++)
          colors.add(pixel(x, y));
      }
      assert.ok(
        colors.size > 2,
        `Glyph at row ${row}, column ${column} must contain antialiased ink`,
      );
    }
    const bounds = { left: Infinity, top: Infinity, right: -1, bottom: -1 };
    let overhang = false;
    for (let y = 4 * cellHeight; y < 5 * cellHeight; y++) {
      for (let x = 11 * cellWidth; x < 12 * cellWidth; x++) {
        if (pixel(x, y) !== "16,32,48") overhang = true;
      }
    }
    assert.ok(overhang, "Italic W must overhang into the following empty cell");
    for (let y = 5 * cellHeight; y < 6 * cellHeight; y++) {
      for (let x = 0; x < 2 * cellWidth; x++) {
        if (pixel(x, y) === "16,32,48") continue;
        bounds.left = Math.min(bounds.left, x);
        bounds.right = Math.max(bounds.right, x);
        bounds.top = Math.min(bounds.top, y);
        bounds.bottom = Math.max(bounds.bottom, y);
      }
    }
    const aspect =
      (bounds.right - bounds.left + 1) / (bounds.bottom - bounds.top + 1);
    assert.ok(
      aspect >= 0.8 && aspect <= 1.15,
      `The square ideograph 口 must retain its aspect ratio, got ${aspect}`,
    );
    const first = await readFile(path);
    await cli.request({ op: "screenshot", path });
    assert.deepEqual(await sharp(path).removeAlpha().raw().toBuffer(), data);
    await cli.request({
      op: "screenshot",
      path,
      font_size: cellWidth > 10 ? 6 : 31,
    });
    assert.notEqual((await sharp(path).metadata()).width, info.width);
    await cli.request({ op: "screenshot", path });
    assert.deepEqual(await sharp(path).removeAlpha().raw().toBuffer(), data);
    await cli.request({
      op: "feed",
      data: "\x1b[?1049h\x1b[2J\x1b[Halternate",
    });
    await cli.request({ op: "screenshot", path });
    assert.notDeepEqual(await sharp(path).removeAlpha().raw().toBuffer(), data);
    await cli.request({ op: "feed", data: "\x1b[?1049l" });
    await cli.request({ op: "screenshot", path });
    assert.deepEqual(await sharp(path).removeAlpha().raw().toBuffer(), data);
    await cli.request({ op: "feed", data: "\x1b[2J\x1b[Hnew frame" });
    await cli.request({ op: "resize", cols: 12, rows: 7 });
    await cli.request({ op: "screenshot", path });
    assert.notDeepEqual(await readFile(path), first);
    const resized = await sharp(path).metadata();
    assert.equal(resized.width, 12 * cellWidth);
    assert.equal(resized.height, 7 * cellHeight);
    assert.equal((await cli.request({ op: "capture" })).text, "new frame");
    await cli.close();
  },
);

test(
  "invalid geometry, malformed protocol, and oversized records fail without hanging",
  { timeout: 15000 },
  () => {
    for (const [args, input, error] of [
      [["--cols", "0"], "", "InvalidGeometry"],
      [
        ["--protocol"],
        '{"op":"feed","data":"a","base64":"Yg=="}\n',
        "ExpectedDataOrBase64",
      ],
      [
        ["--protocol"],
        '{"op":"resize","cols":501,"rows":2}\n',
        "InvalidGeometry",
      ],
      [["--protocol"], '{"op":"feed","base64":"?"}\n', "Invalid"],
      [["--protocol"], "x".repeat(1024 * 1024 + 2), "StreamTooLong"],
    ]) {
      const result = spawnSync(binary, args, { input, timeout: 3000 });
      assert.equal(result.status, 1, String(result.error));
      assert.ok(
        result.stderr.toString().includes(error),
        result.stderr.toString(),
      );
    }
  },
);
