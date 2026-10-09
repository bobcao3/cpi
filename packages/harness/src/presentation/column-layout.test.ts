import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getThemeByName,
  initTheme,
  Diff,
} from "@earendil-works/pi-coding-agent";
import {
  COMPACT_WIDTH_THRESHOLD,
  type TuiMouseEvent,
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { numbered_code_content } from "./code-content.ts";
import { diffContent } from "../llm-editor/diff-content.ts";
import { editDiffOps } from "../llm-editor/diff.ts";
import { script_node } from "../codemode/tree-source.ts";
import { renderEditorTree } from "../llm-editor/editor-tree.ts";
import { createTreeState, ToolTreeComponent } from "../tree/index.ts";
import { previewNode } from "../tree/builtins/tree-content.ts";

setCapabilities({ images: null, trueColor: true, hyperlinks: false });
initTheme("dark");
const theme = getThemeByName("dark")!;
const wide_width = COMPACT_WIDTH_THRESHOLD;
const compact_width = COMPACT_WIDTH_THRESHOLD - 1;
const layout_cases = [
  { width: compact_width, compact: true },
  { width: wide_width, compact: false },
];
const source = "const value = '" + "測試abc".repeat(wide_width) + "';";
const plain = (lines: string[]) =>
  lines.map(stripTerminalSequences).map((line) => line.trimEnd());

function assertColumns(
  lines: string[],
  width: number,
  gutter: number,
  expected: string,
): void {
  assert.ok(lines.length > 1, "The code body must wrap.");
  for (const line of lines) assert.ok(visibleWidth(line) <= width);
  const bodies = lines.map((line) =>
    stripTerminalSequences(line).slice(gutter).trimEnd(),
  );
  assert.equal(bodies.join(""), expected);
}

test("numbered code keeps wrapped bodies outside the gutter and hides numbers below the shared threshold", () => {
  const content = numbered_code_content(source, theme, "typescript");
  const wide = content.component!.render(wide_width);
  assert.match(stripTerminalSequences(wide[0]), /^1 │ /);
  for (const line of wide.slice(1))
    assert.match(stripTerminalSequences(line), /^  │ /);
  assertColumns(wide, wide_width, 4, source);
  for (const width of [Math.floor(wide_width / 2), compact_width]) {
    const mobile = content.component!.render(width);
    assertColumns(mobile, width, 0, source);
    assert.doesNotMatch(mobile.join("\n"), /│/);
  }
  assert.match(
    stripTerminalSequences(content.component!.render(wide_width)[0]),
    /^1 │ /,
  );
});

test("expanded editor diffs keep markers on first rows and hide both number columns on mobile", () => {
  const content = diffContent(
    editDiffOps("", source + "\n", 0, 0),
    theme,
    "fixture.ts",
  );
  const wide = content.component!.render(wide_width);
  assert.match(stripTerminalSequences(wide[0]), /^\+\s+1\s+/);
  assertColumns(wide, wide_width, content.diffLineNumbers as number, source);
  for (const line of wide.slice(1))
    assert.match(stripTerminalSequences(line), /^ {7}/);
  const mobile = content.component!.render(compact_width);
  assertColumns(mobile, compact_width, 2, source);
  assert.match(stripTerminalSequences(mobile[0]), /^\+ /);
  for (const line of mobile.slice(1))
    assert.match(stripTerminalSequences(line), /^ {2}/);
});

test("standard diff layout preserves change markers and numeric code without line numbers", () => {
  for (const { width, compact } of [
    ...layout_cases,
    { width: wide_width * 2, compact: false },
  ]) {
    const lines = new Diff("+123 " + source, {
      theme,
      language: "typescript",
    }).render(width);
    const gutter = compact ? 2 : 5;
    assertColumns(lines, width, gutter, source);
    assert.match(
      stripTerminalSequences(lines[0]),
      compact ? /^\+ / : /^\+123 /,
    );
    for (const line of lines.slice(1))
      assert.match(stripTerminalSequences(line), compact ? /^ {2}/ : /^ {5}/);
  }
  const unnumbered = plain(
    new Diff("+123 + 456", { theme, lineNumbers: false }).render(compact_width),
  );
  assert.deepEqual(unnumbered, ["+123 + 456"]);
});

test("limited code previews clip overflow and count source lines", () => {
  const content = numbered_code_content(
    source + "\nconst next = 2;\nconst last = 3;",
    theme,
    "typescript",
    {
      maxVisualLines: 2,
    },
  );
  for (const { width, compact } of layout_cases) {
    const lines = plain(content.component!.render(width));
    assert.equal(lines.length, 3);
    assert.match(lines[2], /1 hidden lines; open Full content/);
    assert.ok(lines[1].endsWith("const next = 2;"));
    if (!compact) assert.match(lines[1], /^2 │ /);
    else assert.doesNotMatch(lines.join("\n"), /│/);
  }
});

test("Code mode expands in place and retains expansion across tree updates", () => {
  const codes = [
    "const value = 1;",
    source,
    [source, source, source].join("\n"),
    "const first = 1;\nconst second = 2;\nconst third = 3;\nconst hidden = 4;",
  ];
  for (const code of codes) {
    for (const width of [compact_width, wide_width * 2]) {
      const compact = width < COMPACT_WIDTH_THRESHOLD;
      const script = script_node("columns", code, theme);
      const tree = new ToolTreeComponent([script], theme, { padding: 0 });
      const preview = plain(tree.render(width));
      assert.ok(preview.every((line) => visibleWidth(line) <= width));
      assert.ok(!preview.some((line) => line.includes("Full content")));
      const hintIndex = preview.findIndex((line) =>
        /Click.*Ctrl-O to expand/.test(line),
      );
      if (code === codes[0]) {
        assert.equal(hintIndex, -1);
      } else {
        assert.notEqual(hintIndex, -1);
        const event: TuiMouseEvent = {
          type: "click",
          button: "left",
          x: preview[hintIndex].indexOf("..."),
          y: hintIndex,
          screenX: preview[hintIndex].indexOf("..."),
          screenY: hintIndex,
          width,
          height: preview.length,
          ctrl: false,
          shift: false,
          alt: false,
        };
        assert.equal(tree.handleMouse(event)?.handled, true);
      }

      const assertExpanded = () => {
        const lines = plain(tree.render(width));
        const bodyIndent = compact ? 2 : 6;
        const bodyGutter = width - bodyIndent < COMPACT_WIDTH_THRESHOLD ? 0 : 4;
        const bodies = lines
          .slice(1)
          .filter((line) => !/Click.*to (expand|collapse)/.test(line))
          .map((line) => line.slice(bodyIndent + bodyGutter));
        assert.equal(bodies.join(""), code.replace(/\n/g, ""));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        assert.ok(!lines.some((line) => /Click.*Ctrl-O to expand/.test(line)));
        assert.ok(lines.some((line) => /\[-\] Click.*to collapse/.test(line)));
        return lines;
      };
      if (code !== codes[0]) assertExpanded();
      tree.update([script_node("columns", code, theme)], theme);
      if (code !== codes[0]) assertExpanded();
      tree.setExpanded(false, true);
      if (code !== codes[0])
        assert.ok(
          plain(tree.render(width)).some((line) =>
            /Click.*Ctrl-O to expand/.test(line),
          ),
        );
      tree.setExpanded(true);
      if (code !== codes[0]) assertExpanded();
      if (code !== codes[0]) {
        const expanded = assertExpanded();
        const collapse = expanded.findIndex((line) =>
          /\[-\] Click.*to collapse/.test(line),
        );
        const x = expanded[collapse].indexOf("[-]");
        assert.equal(
          tree.handleMouse({
            type: "click",
            button: "left",
            x,
            y: collapse,
            screenX: x,
            screenY: collapse,
            width,
            height: expanded.length,
            ctrl: false,
            shift: false,
            alt: false,
          })?.handled,
          true,
        );
        tree.update([script_node("columns", code, theme)], theme);
        assert.ok(
          plain(tree.render(width)).some((line) =>
            /\.\.\. Click to expand/.test(line),
          ),
        );
        tree.setExpanded(false);
        tree.setExpanded(true);
        assertExpanded();
      }
      tree.dispose();
    }
  }
});

test("Code row limits preserve inline collapse rather than collapsing the parent tool", () => {
  const width = 40;
  const code = "\n".repeat(2000) + `const value = '${"測".repeat(60_000)}';`;
  const script = script_node("row-limit", code, theme);
  const tree = new ToolTreeComponent(
    [
      {
        id: "row-limit",
        label: "Code mode",
        status: "success",
        defaultOpen: true,
        children: [script],
      },
    ],
    theme,
    { padding: 0 },
  );
  const preview = plain(tree.render(width));
  const y = preview.findIndex((line) =>
    line.includes("Click or Ctrl-O to expand"),
  );
  assert.ok(y >= 0);
  const x = preview[y].indexOf("...");
  const event: TuiMouseEvent = {
    type: "click",
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height: preview.length,
    ctrl: false,
    shift: false,
    alt: false,
  };
  assert.equal(tree.handleMouse(event)?.handled, true);
  const expanded = plain(tree.render(width));
  assert.match(expanded.at(-1)!, /display row limit/);
  assert.equal(tree.collapseLarge(), true);
  assert.ok(tree.getVisibleIds().includes(script.id));
  assert.ok(
    plain(tree.render(width)).some((line) =>
      line.includes("Click or Ctrl-O to expand"),
    ),
  );
  tree.dispose();
});

test("recent editor output clips overflow while the full transcript wraps", () => {
  const transcript = Array.from(
    { length: 7 },
    (_, index) => `line${index}: ${source}`,
  ).join("\n");
  const roots = renderEditorTree(
    "edit",
    {
      args: { path: "fixture.ts" },
      phase: "running",
      isError: false,
      result: { content: [{ type: "text", text: transcript }], details: {} },
    },
    theme,
    {
      toolCallId: "columns",
      cwd: process.cwd(),
      state: {},
      viewState: createTreeState(),
      invalidate() {},
    },
  );
  const recent = roots[0].children!.find(
    (node) => node.label === "Recent editor output",
  )!;
  const full = roots[0].children!.find(
    (node) => node.label === "Editor transcript",
  )!;
  const tree = new ToolTreeComponent([recent], theme, { padding: 0 });
  const lines = plain(tree.render(compact_width));
  const recent_lines = recent.content!.text.split("\n");
  assert.equal(lines.length, recent_lines.length + 1);
  for (const [index, line] of recent_lines.entries())
    assert.ok(
      lines[index + 1].trimStart().startsWith(line.split(":", 1)[0] + ":"),
    );
  for (const line of lines) assert.ok(visibleWidth(line) <= compact_width);
  tree.update([{ ...full, defaultOpen: true }], theme);
  assert.ok(
    tree.render(compact_width).length > transcript.split("\n").length + 1,
  );
  tree.dispose();
});

test("limited text, code, and diff views clip source lines before full-content expansion", () => {
  for (const format of ["text", "code", "diff"] as const) {
    const text = [0, 1, 2, 3]
      .map((index) => `${format === "diff" ? "+" : ""}line${index}: ${source}`)
      .join("\n");
    for (const keep of ["start", "end"] as const) {
      const node = previewNode(
        "columns",
        "Preview",
        { text, format, language: "typescript", diffLineNumbers: false },
        theme,
        2,
        keep,
      );
      const lines = plain(node.content!.component!.render(compact_width));
      assert.equal(lines.length, 3);
      const body = keep === "start" ? lines.slice(0, 2) : lines.slice(1);
      assert.ok(body[0].includes(keep === "start" ? "line0:" : "line2:"));
      assert.ok(body[1].includes(keep === "start" ? "line1:" : "line3:"));
      for (const line of lines) assert.ok(visibleWidth(line) <= compact_width);
      const full = new ToolTreeComponent(
        [{ ...node.children![0], defaultOpen: true }],
        theme,
        { padding: 0 },
      );
      assert.ok(
        full.render(compact_width).length > text.split("\n").length + 1,
      );
      full.dispose();
    }
  }
});
