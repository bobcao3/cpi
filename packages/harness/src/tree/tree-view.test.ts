import { TREE_KEYBINDINGS } from "./keybindings.ts";
import { CHILD_PAGE, MAX_DEPTH, MAX_NODES } from "./tree-view-helpers.ts";
import assert from "node:assert";
import { describe, it } from "node:test";
import { type TreeNode, TreeView } from "./tree-view.ts";
import { KeybindingsManager, setKeybindings } from "@earendil-works/pi-tui";
import type {
  Component,
  TuiMouseEvent,
  TuiMouseEventType,
} from "@earendil-works/pi-tui";
import {
  COMPACT_WIDTH_THRESHOLD,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

const wide_width = COMPACT_WIDTH_THRESHOLD;
const compact_width = COMPACT_WIDTH_THRESHOLD - 1;
const layout_cases = [
  { width: Math.floor(wide_width / 2), compact: true },
  { width: compact_width, compact: true },
  { width: wide_width, compact: false },
];

function mouse(
  type: TuiMouseEventType,
  x: number,
  y: number,
  width = wide_width,
  height = 20,
): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

class ProbeBody implements Component {
  events: TuiMouseEvent[] = [];

  render(width: number): string[] {
    return ["body".slice(0, width)];
  }

  invalidate(): void {}

  handleMouse(event: TuiMouseEvent) {
    this.events.push(event);
    return { handled: true, focus: true };
  }
}

const plain = (lines: string[]): string[] =>
  lines.map((line) => stripTerminalSequences(line));

describe("TreeView", () => {
  it("expands forest roots independently", () => {
    for (const { width, compact } of layout_cases) {
      const tree = new TreeView([
        {
          id: "a",
          label: "A",
          children: [
            { id: "a.1", label: "A child" },
            { id: "a.2", label: "A second" },
          ],
        },
        {
          id: "b",
          label: "B",
          children: [
            { id: "b.1", label: "B child" },
            { id: "b.2", label: "B second" },
          ],
        },
      ]);

      assert.deepEqual(
        plain(tree.render(width)),
        compact ? [" ▸A", " ▸B"] : ["  ▸ A", "  ▸ B"],
      );
      assert.equal(
        tree.handleMouse(mouse("click", compact ? 1 : 2, 0, width))?.handled,
        true,
      );
      assert.deepEqual(
        plain(tree.render(width)),
        compact
          ? [" ▾A", " │├ A child", " │└ A second", " ▸B"]
          : ["  ▾ A", "  │ ├─  A child", "  │ └─  A second", "  ▸ B"],
      );
      assert.equal(tree.getRowPosition("b.1"), undefined);
    }
  });

  it("compacts status spacing and nested indentation below the shared threshold", () => {
    const tree = new TreeView([
      {
        id: "root",
        label: "Root",
        status: "success",
        defaultOpen: true,
        children: [
          {
            id: "child",
            label: "Child",
            status: "warning",
            defaultOpen: true,
            children: [
              {
                id: "leaf",
                label: "Leaf",
                status: "error",
                children: [
                  { id: "hidden", label: "Hidden" },
                  { id: "hidden2", label: "Hidden second" },
                ],
              },
              { id: "child-sibling", label: "Child sibling" },
            ],
          },
          { id: "root-sibling", label: "Root sibling" },
        ],
      },
    ]);
    assert.deepEqual(plain(tree.render(compact_width)), [
      "✓▾Root",
      "! ├▾Child",
      "× │├▸Leaf",
      "  │└ Child sibling",
      "  └ Root sibling",
    ]);
    assert.deepEqual(plain(tree.render(wide_width)), [
      "✓ ▾ Root",
      "!   ├─▾ Child",
      "×   │ ├─▸ Leaf",
      "    │ └─  Child sibling",
      "    └─  Root sibling",
    ]);
    tree.render(compact_width);
    tree.handleMouse(mouse("click", 5, 2, compact_width));
    assert.ok(
      !plain(tree.render(compact_width)).some((line) =>
        line.includes("Hidden"),
      ),
    );
    assert.equal(
      tree.handleMouse(mouse("click", 4, 2, compact_width))?.handled,
      true,
    );
    assert.ok(
      plain(tree.render(compact_width)).some((line) => line.includes("Hidden")),
    );
  });

  it("flattens single-child headers and bodies while retaining interaction and sibling layout", () => {
    for (const { width, compact } of layout_cases) {
      const body = new ProbeBody();
      const content: TreeNode = {
        id: "content",
        label: "Content",
        body,
        defaultOpen: true,
      };
      const root: TreeNode = {
        id: "write",
        label: "write",
        status: "success",
        defaultOpen: true,
        children: [content],
      };
      const tree = new TreeView([root]);
      const indent = compact ? "  " : "    ";
      assert.deepEqual(plain(tree.render(width)), [
        compact ? "✓-write" : "✓ - write",
        `${indent}Content:`,
        `${indent}body`,
      ]);
      tree.handleMouse(mouse("click", indent.length, 2, width));
      assert.equal(body.events[0].x, 0);
      assert.equal(body.events[0].width, width - indent.length);
      tree.handleMouse(mouse("click", indent.length, 1, width));
      assert.equal(tree.render(width).length, 3);
      tree.reveal("content");
      tree.handleAction("open");
      assert.equal(tree.render(width).length, 3);
      tree.update([
        { ...root, children: [content, { id: "error", label: "Error" }] },
      ]);
      assert.deepEqual(
        plain(tree.render(width)),
        compact
          ? ["✓▾write", "  ├▾Content", "  │ body", "  └ Error"]
          : ["✓ ▾ write", "    ├─▾ Content", "    │   body", "    └─  Error"],
      );
      assert.equal(tree.getSelectedId(), "content");
      tree.update([root]);
      assert.equal(plain(tree.render(width))[2], `${indent}body`);
      tree.update([
        {
          ...root,
          children: [
            {
              id: "wrapper",
              label: "Wrapper",
              defaultOpen: true,
              children: [content],
            },
            { id: "sibling", label: "Sibling" },
          ],
        },
      ]);
      assert.deepEqual(
        plain(tree.render(width)),
        compact
          ? ["✓▾write", "  ├ Wrapper.Content", "  │ body", "  └ Sibling"]
          : [
              "✓ ▾ write",
              "    ├─  Wrapper.Content",
              "    │   body",
              "    └─  Sibling",
            ],
      );
    }
  });

  it("preserves open descendants and selection through update, reorder, and resize", () => {
    const state = {
      open: new Map<string, boolean>(),
      shownChildren: new Map<string, number>(),
    };
    const roots: TreeNode[] = [
      {
        id: "a",
        label: "A",
        children: [
          {
            id: "b",
            label: "B",
            children: [
              { id: "c", label: "C" },
              { id: "f", label: "F" },
            ],
          },
          { id: "e", label: "E" },
        ],
      },
      { id: "d", label: "D" },
    ];
    const tree = new TreeView(roots, { state });

    tree.reveal("c");
    assert.equal(tree.getSelectedId(), "c");
    tree.update([roots[1]!, roots[0]!]);
    assert.equal(tree.getSelectedId(), "c");
    assert.equal(
      tree
        .render(24)
        .some((line) => stripTerminalSequences(line).includes("C")),
      true,
    );

    tree.handleInput("\x1b[A");
    tree.handleInput("\x1b[A");
    assert.equal(tree.getSelectedId(), "a");
    tree.handleInput("\x1b[D");
    assert.equal(state.open.get("a"), false);
    tree.update([roots[1]!, roots[0]!]);
    tree.handleInput("\x1b[C");
    assert.equal(
      tree
        .render(16)
        .some((line) => stripTerminalSequences(line).includes("C")),
      true,
    );
  });

  it("fits ANSI and wide unicode text into narrow widths", () => {
    const tree = new TreeView(
      [
        {
          id: "wide",
          label: "測試 \x1b[31mred\x1b[0m",
          summary: "summary",
          metadata: ["meta"],
        },
      ],
      { theme: { selected: (text) => `\x1b[7m${text}\x1b[0m` } },
    );

    for (const width of [0, 1, 2, 5]) {
      for (const line of tree.render(width))
        assert.ok(visibleWidth(line) <= width);
      tree.invalidate();
    }
  });

  it("uses configurable tree keybindings", () => {
    setKeybindings(
      new KeybindingsManager(TREE_KEYBINDINGS, {
        "tui.tree.down": "j",
        "tui.tree.up": "k",
      }),
    );
    try {
      const tree = new TreeView([
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ]);

      tree.handleInput("\x1b[B");
      assert.equal(tree.getSelectedId(), "a");
      tree.handleInput("j");
      assert.equal(tree.getSelectedId(), "b");
      tree.handleInput("k");
      assert.equal(tree.getSelectedId(), "a");
    } finally {
      setKeybindings(new KeybindingsManager(TREE_KEYBINDINGS));
    }
  });

  it("paginates large child sets and asserts duplicate ids", () => {
    const extra = 5;
    const children = Array.from({ length: CHILD_PAGE + extra }, (_, index) => ({
      id: `child-${index}`,
      label: `Child ${index}`,
    }));
    const tree = new TreeView([
      { id: "root", label: "Root", defaultOpen: true, children },
    ]);

    let rendered = plain(tree.render(wide_width));
    assert.equal(
      rendered.some((line) => line.includes(children.at(-1)!.label)),
      false,
    );
    const moreRow = rendered.findIndex((line) =>
      line.includes(`${extra} more`),
    );
    assert.equal(
      plain(tree.render(compact_width))[moreRow],
      `  └▸${extra} more`,
    );
    assert.equal(
      tree.handleMouse(mouse("click", 1, moreRow, compact_width))?.handled,
      true,
    );
    rendered = plain(tree.render(wide_width));
    assert.equal(
      rendered.some((line) => line.includes(children.at(-1)!.label)),
      true,
    );
    assert.throws(
      () =>
        new TreeView([
          { id: "x", label: "X" },
          { id: "x", label: "Y" },
        ]),
      /duplicate id x/,
    );
  });

  it("rejects cycles and trees beyond bounded depth or node budgets", () => {
    const cycle: TreeNode = { id: "cycle", label: "Cycle" };
    cycle.children = [cycle];
    assert.throws(() => new TreeView([cycle]), /cycle/);
    let deep: TreeNode = { id: "leaf", label: "Leaf" };
    for (let depth = 0; depth <= MAX_DEPTH; depth++)
      deep = { id: `depth-${depth}`, label: "Deep", children: [deep] };
    assert.throws(() => new TreeView([deep]), /depth limit/);
    const roots = Array.from({ length: MAX_NODES + 1 }, (_, index) => ({
      id: `root-${index}`,
      label: "Root",
    }));
    assert.throws(() => new TreeView(roots), /node limit/);
  });

  it("keeps mouse toggling on the marker and dispatches body clicks with translated coordinates", () => {
    for (const { width, compact } of layout_cases) {
      const body = new ProbeBody();
      const tree = new TreeView([{ id: "a", label: "A", body }]);

      tree.render(width);
      assert.equal(tree.handleMouse(mouse("click", 5, 0))?.handled, true);
      assert.equal(tree.getSelectedId(), "a");
      assert.deepEqual(plain(tree.render(width)), [compact ? " ▸A" : "  ▸ A"]);
      tree.handleMouse(mouse("click", compact ? 2 : 4, 0, width));
      assert.equal(tree.render(width).length, 1);
      assert.equal(
        tree.handleMouse(mouse("click", compact ? 1 : 2, 0, width))?.handled,
        true,
      );
      assert.deepEqual(
        plain(tree.render(width)).slice(0, 2),
        compact ? [" ▾A", "  body"] : ["  ▾ A", "      body"],
      );

      const result = tree.handleMouse(
        mouse("click", compact ? 4 : 8, 1, width),
      );
      assert.equal(result?.handled, true);
      assert.equal(result?.focus, false);
      assert.equal(body.events[0]?.x, 2);
      assert.equal(body.events[0]?.y, 0);
      assert.equal(
        tree.handleMouse({ ...mouse("wheel", 1, 1), wheelDelta: 1 }),
        undefined,
      );
    }
  });
});
