import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderEditorCall, renderEditorResult } from "./render.ts";
import { getCwd, setCwd } from "../lib/cwd.ts";

const theme = getThemeByName("dark")!;
const rows = (component: { render(width: number): string[] }) =>
  component
    .render(120)
    .map(stripVTControlCharacters)
    .map((l) => l.trimEnd());
// The half-height background fringes (▄ top, ▀ bottom) bracket the panel.
const panel = (component: { render(width: number): string[] }) => {
  const all = rows(component);
  assert.ok(all[0]!.startsWith("▄"), `missing top fringe: ${all[0]}`);
  assert.ok(
    all.at(-1)!.startsWith("▀"),
    `missing bottom fringe: ${all.at(-1)}`,
  );
  return all.slice(1, -1);
};
const callHead = (path: string) =>
  panel(renderEditorCall("edit", { path }, theme, { isPartial: true }))[0]!;

test("editor panels extend half a row past top and bottom", () => {
  const all = renderEditorResult(
    "edit",
    { details: { kind: "edit", path: "src/a.ts", hunks: 1, diffOps: [] } },
    { isPartial: false },
    theme,
  ).render(120);
  const fg = theme.getBgAnsi("toolPendingBg").replace("48;", "38;");
  assert.equal(all[0], `${fg}${"▄".repeat(120)}\x1b[39m`);
  assert.equal(all.at(-1), `${fg}${"▀".repeat(120)}\x1b[39m`);
});

test("edit call head shows the shortest path form", () => {
  const initial = getCwd();
  const cwd = join(homedir(), "work", "project");
  setCwd(cwd);
  try {
    assert.equal(
      callHead(join(cwd, "src", "a.ts")).trim(),
      "⏳ edit: src/a.ts",
    );
    assert.equal(
      callHead(join(homedir(), "notes.txt")).trim(),
      "⏳ edit: ~/notes.txt",
    );
    assert.equal(callHead("/etc/hosts").trim(), "⏳ edit: /etc/hosts");
  } finally {
    setCwd(initial);
  }
});

test("edit result head carries status and reason", () => {
  const ok = panel(
    renderEditorResult(
      "edit",
      {
        details: {
          kind: "edit",
          path: "src/a.ts",
          hunks: 1,
          diffOps: [{ type: "add", old: null, new: 1, text: "x" }],
        },
      },
      { isPartial: false },
      theme,
    ),
  );
  assert.equal(ok[0]!, " ✓ edit: src/a.ts · applied 1 hunk");
  assert.equal(ok[1]!, " +   1  x");

  const err = panel(
    renderEditorResult(
      "apply_patch",
      {
        isError: true,
        content: [{ type: "text", text: "" }],
        details: {
          kind: "error",
          path: "src/a.ts",
          message: "hunk did not apply",
        },
      },
      { isPartial: false },
      theme,
    ),
  );
  assert.deepEqual(err, [
    " ✗ apply_patch: src/a.ts failed",
    "   └ hunk did not apply",
  ]);
});
