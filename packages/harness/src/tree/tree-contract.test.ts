import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMPACT_WIDTH_THRESHOLD,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { type TreeNode, TreeView } from "./tree-view.ts";

const node = (
  label: string,
  children: TreeNode[] = [],
  summary?: string,
): TreeNode => ({ id: label, label, children, summary });
const tail = (): TreeNode => ({
  ...node("D"),
  body: new Text("...", 0, 0),
  defaultOpen: true,
});
const plain = (line: string) => stripTerminalSequences(line).trimEnd();
const cases = [
  {
    root: node("A", [node("B", [node("C", [tail()])])]),
    lines: ["- A", "  B.C.D:", "  ..."],
    compactLines: [" -A", "  B.C.D:", "  ..."],
  },
  {
    root: node(
      "A",
      [node("B", [node("C", [tail()], "25s")])],
      "No background shells",
    ),
    lines: ["- A · No background shells", "  B: C · 25s", "  D:", "  ..."],
    compactLines: [
      " -A · No background shells",
      "  B: C · 25s",
      "  D:",
      "  ...",
    ],
  },
  {
    root: node("A", [
      {
        ...node("B", [], "25s"),
        body: new Text("...", 0, 0),
        defaultOpen: true,
      },
    ]),
    lines: ["- A: B · 25s", "  ..."],
    compactLines: [" -A: B · 25s", "  ..."],
  },
  {
    root: node("A", [{ ...node("B"), metadata: ["PID=5"] }]),
    lines: ["- A", "  B · PID=5"],
    compactLines: [" -A", "  B · PID=5"],
  },
];

test("single-child contraction follows attribute boundaries without changing marker alignment", () => {
  for (const { root, lines, compactLines } of cases) {
    const tree = new TreeView([root]);
    for (const width of [
      COMPACT_WIDTH_THRESHOLD - 1,
      COMPACT_WIDTH_THRESHOLD,
    ]) {
      const expected =
        width < COMPACT_WIDTH_THRESHOLD
          ? compactLines
          : lines.map((line) => "  " + line);
      assert.deepEqual(tree.render(width).map(plain), expected);
      tree.handleAction("toggle");
      assert.deepEqual(tree.render(width).map(plain), expected);
    }
    tree.update([root]);
    assert.deepEqual(
      tree.render(COMPACT_WIDTH_THRESHOLD).map(plain),
      lines.map((line) => "  " + line),
    );
  }
});

test("contraction retains triangles and reveal targets for real branches and deferred full content", () => {
  for (const children of [
    [tail()],
    [{ ...node("B", [node("Metadata")]), body: new Text("BODY", 0, 0) }],
  ]) {
    const contracted = new TreeView([
      { ...node("Collapsed", children), defaultOpen: false },
    ]);
    assert.equal(contracted.render(COMPACT_WIDTH_THRESHOLD).length, 1);
    assert.match(contracted.render(COMPACT_WIDTH_THRESHOLD)[0], /▸ Collapsed/);
    contracted.handleAction("open");
    assert.ok(contracted.render(COMPACT_WIDTH_THRESHOLD).length > 1);
    contracted.handleAction("close");
    assert.equal(contracted.render(COMPACT_WIDTH_THRESHOLD).length, 1);
    contracted.dispose();
  }
  const full: TreeNode = {
    ...node("Full content"),
    body: new Text("FULL", 0, 0),
    defaultOpen: false,
  };
  const root = node("A", [node("B", [node("C", [full, node("Other")])])]);
  const tree = new TreeView([root]);
  assert.match(tree.render(COMPACT_WIDTH_THRESHOLD)[0], /▸ A/);
  tree.handleAction("open");
  let lines = tree.render(COMPACT_WIDTH_THRESHOLD).map(plain);
  assert.ok(lines.some((line) => /▸ Full content/.test(line)));
  assert.ok(!lines.some((line) => line.includes("FULL")));
  tree.reveal("C");
  assert.equal(tree.getRowPosition("C"), tree.getRowPosition("B"));
  tree.reveal("Full content");
  tree.handleAction("open");
  lines = tree.render(COMPACT_WIDTH_THRESHOLD).map(plain);
  assert.ok(lines.some((line) => /▾ Full content/.test(line)));
  assert.ok(lines.some((line) => line.includes("FULL")));
});
