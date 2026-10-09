import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Text,
  stripTerminalSequences,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { TreeView } from "./tree-view.ts";
import { MAX_ROWS } from "./tree-view-helpers.ts";

const width = 80;
const render = (tree: TreeView, height: number) =>
  tree.render(width, height).map(stripTerminalSequences);

function click(tree: TreeView, lines: string[], row: number): void {
  const x = lines[row]!.indexOf("[-]");
  const event: TuiMouseEvent = {
    type: "click",
    button: "left",
    x,
    y: row,
    screenX: x,
    screenY: row,
    width,
    height: 20,
    ctrl: false,
    shift: false,
    alt: false,
  };
  assert.equal(tree.handleMouse(event)?.handled, true);
}

function treeWithRows(rows: number): TreeView {
  return new TreeView([
    {
      id: "root",
      label: "Root",
      defaultOpen: false,
      children: [
        {
          id: "body",
          label: "Body",
          body: new Text(
            Array.from({ length: rows }, (_, index) => `Row ${index}`).join(
              "\n",
            ),
            0,
            0,
          ),
        },
      ],
    },
  ]);
}

test("large contracted subtrees keep bottom collapse controls across height changes and row limits", () => {
  for (const rows of [8, 9, MAX_ROWS]) {
    const tree = treeWithRows(rows);
    assert.equal(render(tree, 20).length, 1);
    tree.handleAction("open");
    let lines = render(tree, 20);
    let footer = lines.findIndex((line) =>
      line.includes("[-] Click or Ctrl-Minus to collapse"),
    );
    if (rows === 8) {
      assert.equal(footer, -1);
      tree.dispose();
      continue;
    }
    assert.ok(footer > lines.findIndex((line) => line.includes("Row 0")));
    if (rows === 9) {
      assert.ok(!render(tree, 40).some((line) => line.includes("to collapse")));
      lines = render(tree, 20);
      footer = lines.findIndex((line) => line.includes("to collapse"));
    } else {
      assert.equal(lines.length, MAX_ROWS);
      assert.match(lines.at(-2)!, /\[-\] Click or Ctrl-Minus to collapse/);
    }
    click(tree, lines, footer);
    assert.equal(render(tree, 20).length, 1);
    tree.handleAction("open");
    render(tree, 20);
    tree.handleInput("\x1f");
    assert.equal(render(tree, 20).length, 1);
    tree.dispose();
  }
});
