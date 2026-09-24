import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { readTool } from "./tool.ts";

const theme = getThemeByName("dark")!;
const visible = (component: { render(width: number): string[] }) =>
  component.render(80).map(stripVTControlCharacters).join("\n").trimEnd();

test("read tool keeps file content in result but not the blockless TUI", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-inline-"));
  const path = join(dir, "sample.txt");
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
    assert.equal(done, "✓ Read sample.txt:1 lines");
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
      "✓ Read sample.txt:L1-10,2,3,6-200 Defines an exported parser",
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
      "✓ Read sample.txt: Query complete (summary unavailable)",
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
    assert.ok(failed.startsWith("✗ Failed to read missing.txt: "));
    assert.ok(!failed.includes("secret file contents"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read path is underlined and linked only in hyperlink-capable terminals", () => {
  const path = "/tmp/read with spaces.ts";
  const args = { path, query: "find helper" };
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
  assert.ok(lines.includes(theme.fg("warning", "10 lines")));
  const ranges = render({
    kind: "view",
    ranges: [
      [1, 10],
      [12, 12],
    ],
    summary: "Relevant description",
  });
  assert.ok(ranges.includes(theme.fg("warning", "L1-10,12")));
  assert.ok(ranges.includes(theme.fg("text", " Relevant description")));
});

test("read line count covers empty, unterminated, and capped file reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-lines-"));
  const path = join(dir, "sample.txt");
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
        `✓ Read sample.txt:${expected} lines`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
