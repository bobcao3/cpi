import assert from "node:assert/strict";
import { test } from "node:test";
import { getThemeByName, initTheme } from "@earendil-works/pi-coding-agent";
import {
  setCapabilities,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { editDiffOps } from "../llm-editor/diff.ts";
import { renderEditorTree } from "../llm-editor/editor-tree.ts";
import {
  createTreeState,
  ToolTreeComponent,
  type ToolTreeContext,
} from "../tree/index.ts";
import { writeRenderers } from "../tree/builtins/write.ts";
import { renderToolTreeHtml } from "./tree-renderer.ts";
import { ansiToHtml } from "./ansi-to-html.ts";
import { codemode_renderers } from "../codemode/tree-render.ts";

setCapabilities({ images: null, trueColor: true, hyperlinks: false });
initTheme("dark");

function context(): ToolTreeContext {
  return {
    toolCallId: "syntax",
    cwd: process.cwd(),
    state: {},
    viewState: createTreeState(),
    invalidate() {},
  };
}

for (const name of ["dark", "light"]) {
  test(`${name} editor diffs and numbered write code retain grammar in terminal and HTML`, () => {
    const theme = getThemeByName(name)!;
    const before = "const count = 1; // café 測試\n";
    const after = "const count = 42; // café 測試\n";
    const roots = renderEditorTree(
      "apply_patch",
      {
        args: { path: "fixture.ts" },
        phase: "complete",
        isError: false,
        result: {
          content: [],
          details: {
            path: "fixture.ts",
            diffOps: editDiffOps(before, after, 2, 2),
          },
        },
      },
      theme,
      context(),
    );
    const component = new ToolTreeComponent(roots, theme, { padding: 0 });
    const ansi = component.render(100).join("\n");
    assert.equal((ansi.match(/\x1b\[1mconst/g) ?? []).length, 2);
    assert.equal((ansi.match(/\x1b\[3m\/\/ café 測試/g) ?? []).length, 2);
    assert.match(ansi, /\x1b\[7m/);
    const html = renderToolTreeHtml(roots, theme);
    assert.equal((html.match(/font-weight:bold[^>]*>const/g) ?? []).length, 2);
    const keywordColors = Array.from(
      html.matchAll(
        /color:rgb\((\d+),(\d+),(\d+)\);font-weight:bold[^>]*>const/g,
      ),
      (match) => match.slice(1).map(Number),
    );
    assert.equal(keywordColors.length, 2);
    const [removed, added] = keywordColors;
    assert.ok(removed[0] > removed[1] && removed[0] > removed[2]);
    assert.ok(added[1] > added[0] && added[1] > added[2]);
    assert.equal(
      (html.match(/font-style:italic[^>]*>\/\/ café 測試/g) ?? []).length,
      2,
    );
    assert.ok(!html.includes("\x1b"));
    for (const width of [0, 1, 12, 35]) {
      component.invalidate();
      for (const line of component.render(width))
        assert.ok(visibleWidth(line) <= width);
    }
    component.dispose();

    const written = after + "/*\nconst inside = '<&>';\n*/\n";
    const created = {
      content: [],
      details: {
        kind: "create",
        path: "fixture.ts",
        bytes: Buffer.byteLength(written),
        diffOps: editDiffOps("", written, 0, 0),
      },
    };
    const writes = [
      renderEditorTree(
        "write",
        {
          args: { path: "fixture.ts", file_text: written },
          phase: "running",
          isError: false,
        },
        theme,
        context(),
      ),
      ...[true, false].map((retainSource) =>
        renderEditorTree(
          "write",
          {
            args: {
              path: "fixture.ts",
              ...(retainSource ? { file_text: written } : {}),
            },
            phase: "complete",
            isError: false,
            result: created,
          },
          theme,
          context(),
        ),
      ),
      writeRenderers.renderTree!(
        {
          args: { path: "fixture.ts", content: written },
          phase: "complete",
          isError: false,
        },
        theme,
        context(),
      ),
    ];
    for (const write of writes) {
      const tree = new ToolTreeComponent(write, theme, { padding: 0 });
      tree.setExpanded(true);
      const rendered = tree.render(100).join("\n");
      const plain = stripTerminalSequences(rendered);
      assert.ok(plain.includes("1 │ const count = 42; // café 測試"));
      assert.ok(plain.includes("3 │ const inside = '<&>';"));
      assert.ok(plain.includes("4 │ */"));
      assert.doesNotMatch(plain, /\bDiff\b|\+\s+1\s+const count/);
      const writeHtml = renderToolTreeHtml(write, theme);
      for (const [color, text] of [
        ["syntaxKeyword", "const"],
        ["syntaxComment", "const inside = '<&>';"],
        ["muted", "1 │ "],
      ] as const) {
        const expected = ansiToHtml(theme.fg(color, text));
        assert.ok(ansiToHtml(rendered).includes(expected), `${color}: ${text}`);
        assert.ok(writeHtml.includes(expected), `HTML ${color}: ${text}`);
      }
      assert.ok(writeHtml.includes("&lt;&amp;&gt;"));
      assert.ok(!writeHtml.includes("\x1b"));
      for (const width of [0, 1, 12, 35]) {
        tree.invalidate();
        for (const line of tree.render(width))
          assert.ok(visibleWidth(line) <= width);
      }
      tree.dispose();
    }
  });
}

for (const name of ["dark", "light"]) {
  test(`${name} Code mode uses the activity syntax palette with muted ordinary text`, () => {
    const theme = getThemeByName(name)!;
    const code =
      'const plain = await tools.read({path:"/tmp/plain.ts"});\nconst number = 7;\n// muted comment\nconst tail = "after";';
    const roots = codemode_renderers.renderTree!(
      { args: { code }, phase: "complete", isError: false },
      theme,
      context(),
    );
    const script = roots[0].children!.find(
      (node) => stripTerminalSequences(node.label) === "Script",
    )!;
    for (const content of [script.content!, script.children![0].content!]) {
      const body = content.component!.render(120).join("\n");
      assert.equal(
        body
          .split("\n")
          .map((line) => stripTerminalSequences(line).trimEnd())
          .join("\n"),
        content.text,
      );
      const styled = ansiToHtml(body);
      for (const [color, text] of [
        ["muted", " plain = "],
        ["muted", " tools.read({"],
        ["syntaxKeyword", "await"],
        ["syntaxString", '"/tmp/plain.ts"'],
        ["syntaxNumber", "7"],
        ["syntaxComment", "// muted comment"],
      ] as const) {
        const expected = ansiToHtml(theme.fg(color, text));
        assert.ok(styled.includes(expected), `${color}: ${text}`);
        assert.ok(
          renderToolTreeHtml(
            [{ id: "script", label: "Script", content }],
            theme,
          ).includes(expected),
          `HTML ${color}: ${text}`,
        );
      }
    }
    const tree = new ToolTreeComponent(roots, theme);
    for (const width of [1, 20, 80]) {
      tree.invalidate();
      for (const line of tree.render(width))
        assert.ok(visibleWidth(line) <= width);
    }
    tree.dispose();
  });
}

test("collapsed removal previews retain multiline grammar and patch hunks reset grammar", () => {
  const theme = getThemeByName("dark")!;
  const before = [
    "/*",
    ...Array.from({ length: 12 }, (_, n) => `const comment${n} = ${n};`),
    "*/",
    "const live = 9;",
  ].join("\n");
  const roots = renderEditorTree(
    "edit",
    {
      args: { path: "fixture.ts" },
      phase: "complete",
      isError: false,
      result: {
        content: [],
        details: { diffOps: editDiffOps(before, "", 0, 0) },
      },
    },
    theme,
    context(),
  );
  const diff = roots[0].children!.find(
    (node) => node.label === "Diff",
  )!.content!;
  const rendered = diff.component!.render(100).join("\n");
  assert.match(rendered, /\x1b\[3mconst comment/);
  assert.match(rendered, /\x1b\[1mconst/);
  assert.ok(stripTerminalSequences(rendered).includes("…"));
  diff.component!.invalidate();
  assert.equal(diff.component!.render(100).join("\n"), rendered);
  const patch =
    "--- fixture.ts\n+++ fixture.ts\n@@ -1 +1 @@\n-/*\n+/*\n@@ -10 +10 @@\n-const n = 1;\n+const n = 2;\n+123 + 4";
  const patchRoots = renderEditorTree(
    "apply_patch",
    { args: { path: "fixture.ts", patch }, phase: "running", isError: false },
    theme,
    context(),
  );
  const tree = new ToolTreeComponent(patchRoots, theme);
  tree.setExpanded(true);
  const ansi = tree.render(100).join("\n");
  assert.match(ansi, /\x1b\[1mconst/);
  assert.ok(stripTerminalSequences(ansi).includes("+123 + 4"));
  assert.match(
    renderToolTreeHtml(patchRoots, theme),
    /font-weight:bold[^>]*>const/,
  );
  tree.dispose();
});
