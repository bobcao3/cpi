import assert from "node:assert/strict";
import { test } from "node:test";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { buildFooterRows } from "./footer-rows.ts";

const mouse = (type: TuiMouseEvent["type"]): TuiMouseEvent => ({
  type,
  button: "left",
  x: 0,
  y: 0,
  screenX: 0,
  screenY: 0,
  width: 10,
  height: 1,
  shift: false,
  alt: false,
  ctrl: false,
});

test("footer activity regions leave presses selectable and handle clicks", () => {
  const opened: string[] = [];
  const { hits } = buildFooterRows(
    80,
    getThemeByName("dark")!,
    [{ name: "shell", value: "shell:1 mon:2" }],
    undefined,
    (kind) => opened.push(kind),
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0]!.region.handleMouse(mouse("press")), undefined);
  assert.deepEqual(opened, []);
  assert.equal(hits[0]!.region.handleMouse(mouse("click"))?.handled, true);
  assert.deepEqual(opened, ["shell"]);
});
