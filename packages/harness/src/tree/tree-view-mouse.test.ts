import assert from "node:assert/strict";
import { test } from "node:test";
import type { TuiMouseEvent, TuiMouseEventType } from "@earendil-works/pi-tui";
import { TreeView } from "./tree-view.ts";

const mouse = (type: TuiMouseEventType): TuiMouseEvent => ({
  type,
  button: "left",
  x: 2,
  y: 0,
  screenX: 2,
  screenY: 0,
  width: 80,
  height: 20,
  shift: false,
  alt: false,
  ctrl: false,
});

test("tree disclosure markers leave presses selectable and handle clicks", () => {
  const tree = new TreeView([
    {
      id: "root",
      label: "Root",
      children: [
        { id: "first", label: "First" },
        { id: "second", label: "Second" },
      ],
    },
  ]);
  assert.equal(tree.render(80).length, 1);
  assert.equal(tree.handleMouse(mouse("press")), undefined);
  assert.equal(tree.render(80).length, 1);
  assert.equal(tree.handleMouse(mouse("click"))?.handled, true);
  assert.equal(tree.render(80).length, 3);
});
