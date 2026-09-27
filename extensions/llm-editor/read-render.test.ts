import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { readTool } from "./tool.ts";
import { faint, fileLabel, readFileLabel } from "./read-batch.ts";
import { getCwd, setCwd } from "../lib/cwd.ts";
import { expandSourcePath } from "../lib/skill-paths.ts";

const theme = getThemeByName("dark")!;
const visible = (component: { render(width: number): string[] }) =>
  component.render(80).map(stripVTControlCharacters).join("\n").trimEnd();

test("read tool keeps file content in result but not the blockless TUI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-inline-"));
  const path = join(dir, "sample.txt");
  const initial = getCwd();
  setCwd(dir);
  try {
    await writeFile(path, "secret file contents\n");
    assert.equal(readTool.renderShell, "self");
    const args = { path, query: "find content\nnot shown" };
    const pending = readTool.renderCall(args, theme, {
      isPartial: true,
    } as any);
    assert.equal(visible(pending), "⏳ Reading sample.txt for find content");
    assert.equal(
      visible(readTool.renderCall(args, theme, { isPartial: false } as any)),
      "",
    );
    const result = await readTool.execute(
      "test",
      { path },
      undefined,
      undefined,
      { cwd: dir } as any,
    );
    assert.ok(
      result.content[0]?.type === "text" &&
        result.content[0].text.includes("secret file contents"),
    );
    const context = { args, isError: false } as any;
    assert.equal(
      visible(
        readTool.renderResult(
          result,
          { isPartial: true, expanded: false },
          theme,
          context,
        ),
      ),
      "",
    );
    const done = visible(
      readTool.renderResult(
        result,
        { isPartial: false, expanded: false },
        theme,
        context,
      ),
    );
    assert.equal(done, " ✓ Read sample.txt:1 lines");
    assert.equal((result.details as { lineCount: number }).lineCount, 1);
    assert.ok(!done.includes("secret file contents"));
    assert.equal(
      visible(
        readTool.renderResult(
          result,
          { isPartial: false, expanded: true },
          theme,
          context,
        ),
      ),
      done,
    );
    const viewer = {
      ...result,
      details: {
        kind: "view",
        summary: "Defines an exported parser",
        ranges: [
          [1, 10],
          [2, 2],
          [3, 3],
          [6, 200],
        ],
      },
    };
    assert.equal(
      visible(
        readTool.renderResult(
          viewer,
          { isPartial: false, expanded: false },
          theme,
          context,
        ),
      ),
      " ✓ Read sample.txt:L1-10,2,3,6-200 Defines an exported parser",
    );
    assert.equal(
      visible(
        readTool.renderResult(
          { ...result, details: { kind: "view" } },
          { isPartial: false, expanded: false },
          theme,
          context,
        ),
      ),
      " ✓ Read sample.txt: Query complete (summary unavailable)",
    );
    const error = await readTool.execute(
      "test",
      { path: join(dir, "missing.txt") },
      undefined,
      undefined,
      { cwd: dir } as any,
    );
    const failed = visible(
      readTool.renderResult(
        error,
        { isPartial: false, expanded: false },
        theme,
        { args: { path: join(dir, "missing.txt") }, isError: true } as any,
      ),
    );
    assert.ok(failed.startsWith(" ✗ Failed to read missing.txt: "));
    assert.ok(!failed.includes("secret file contents"));
  } finally {
    setCwd(initial);
    await rm(dir, { recursive: true, force: true });
  }
});

test("read path is underlined and linked only in hyperlink-capable terminals", () => {
  const path = "/tmp/read with spaces.ts";
  const args = { path, query: "find helper" };
  const initial = getCwd();
  setCwd("/tmp");
  try {
    setCapabilityOverrides({ hyperlinks: true });
    const call = readTool
      .renderCall(args, theme, { isPartial: true } as any)
      .render(100)
      .join("\n");
    const link = `\x1b]8;;${pathToFileURL(path).href}\x1b\\`;
    assert.ok(call.includes(link));
    assert.ok(call.includes("\x1b[4mread with spaces.ts\x1b[24m"));
    const clipped = readTool
      .renderCall(args, theme, { isPartial: true } as any)
      .render(18)[0];
    assert.ok(clipped.includes("\x1b]8;;\x1b\\"));
    const done = readTool
      .renderResult(
        { content: [], details: { kind: "content" } },
        { isPartial: false, expanded: false },
        theme,
        { args, isError: false } as any,
      )
      .render(100)
      .join("\n");
    assert.ok(done.includes(link));
    setCapabilityOverrides({ hyperlinks: false });
    const plain = readTool
      .renderCall(args, theme, { isPartial: true } as any)
      .render(100)
      .join("\n");
    assert.ok(!plain.includes("\x1b]8;"));
    assert.ok(!plain.includes("\x1b[4m"));
    assert.ok(stripVTControlCharacters(plain).includes("read with spaces.ts"));
  } finally {
    setCapabilityOverrides({});
    setCwd(initial);
  }
});

test("read links resolve source path prefixes rather than treating them as cwd-relative", async () => {
  const initial = getCwd();
  const args = { path: "$CPI_HARNESS_SRC/AGENTS.md" };
  const absolute = expandSourcePath(args.path);
  setCwd("/tmp");
  setCapabilityOverrides({ hyperlinks: true });
  try {
    const expected = `\x1b]8;;${pathToFileURL(absolute).href}\x1b\\`;
    const call = readTool
      .renderCall(args, theme, { isPartial: true } as any)
      .render(120)
      .join("\n");
    assert.ok(call.includes(expected), call);
    const read = await readTool.execute(
      "prefixed-read",
      args,
      undefined,
      undefined,
      { cwd: "/tmp" } as any,
    );
    assert.equal((read.details as { path: string }).path, absolute);
    const result = readTool
      .renderResult(read, { isPartial: false, expanded: false }, theme, {
        args,
        isError: false,
      } as any)
      .render(120)
      .join("\n");
    assert.ok(result.includes(expected), result);
  } finally {
    setCapabilityOverrides({});
    setCwd(initial);
  }
});

test("contracted cwd and home labels retain complete file URLs", () => {
  const initial = getCwd();
  const home = homedir();
  const cwd = join(home, "work", "project");
  setCwd(cwd);
  setCapabilityOverrides({ hyperlinks: true });
  try {
    const inside = join(cwd, "src", "a b.ts");
    const outside = join(home, "notes.txt");
    for (const [label, path, render] of [
      ["src/a b.ts", inside, () => fileLabel(inside, theme)],
      ["~/notes.txt", outside, () => fileLabel(outside, theme)],
      ["~/notes.txt", outside, () => readFileLabel("$HOME/notes.txt", theme)],
    ] as const) {
      const text = render();
      assert.ok(text.includes(`\x1b[4m${label}\x1b[24m`), text);
      assert.ok(
        text.includes(`\x1b]8;;${pathToFileURL(path).href}\x1b\\`),
        text,
      );
    }
  } finally {
    setCapabilityOverrides({});
    setCwd(initial);
  }
});

test("read result highlights the range/count separately from the description", () => {
  const context = { args: { path: "/tmp/sample.txt" }, isError: false } as any;
  const render = (details: object) =>
    readTool
      .renderResult(
        { content: [], details },
        { isPartial: false, expanded: false },
        theme,
        context,
      )
      .render(120)
      .join("\n");
  const lines = render({ kind: "content", lineCount: 10 });
  assert.ok(lines.includes(faint(theme, "warning", "10 lines")));
  const ranges = render({
    kind: "view",
    ranges: [
      [1, 10],
      [12, 12],
    ],
    summary: "Relevant description",
  });
  assert.ok(ranges.includes(faint(theme, "warning", "L1-10,12")));
  assert.ok(ranges.includes(theme.fg("dim", " Relevant description")));
});

test("read line count covers empty, unterminated, and capped file reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-lines-"));
  const path = join(dir, "sample.txt");
  const initial = getCwd();
  setCwd(dir);
  try {
    for (const [body, expected] of [
      ["", 0],
      ["one\ntwo", 2],
      ["line\n".repeat(200), 200],
      ["line\n".repeat(250), 200],
    ] as const) {
      await writeFile(path, body);
      const result = await readTool.execute(
        "test",
        { path },
        undefined,
        undefined,
        { cwd: dir } as any,
      );
      assert.equal(
        (result.details as { lineCount: number }).lineCount,
        expected,
      );
      if (body === "line\n".repeat(200))
        assert.equal(result.content[0]?.text, body);
      assert.equal(
        visible(
          readTool.renderResult(
            result,
            { isPartial: false, expanded: false },
            theme,
            { args: { path }, isError: false } as any,
          ),
        ),
        ` ✓ Read sample.txt:${expected} lines`,
      );
    }
  } finally {
    setCwd(initial);
    await rm(dir, { recursive: true, force: true });
  }
});
