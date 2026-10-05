import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import { renderLspCall, renderLspResult } from "./lsp-render.ts";
import { renderRepeatCall, renderRepeatResult } from "./shell/repeat-render.ts";

const theme = getThemeByName("dark")!;
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(110)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");

test("LSP check distinguishes diagnostics from a clean result and failure", () => {
  const args = { command: "check" as const, file: "src/app.ts" };
  const context = { args, isError: false };
  assert.equal(
    plain(renderLspCall(args, theme, { ...context, isPartial: true })),
    "⏳ lsp check: src/app.ts",
  );
  assert.equal(
    plain(renderLspCall({}, theme, { ...context, isPartial: true })),
    "⏳ lsp …:",
  );
  assert.equal(
    plain(renderLspCall(args, theme, { ...context, isPartial: false })),
    "",
  );
  const result = renderLspResult(
    {
      content: [
        { type: "text", text: "L7:2 error[tsserver] unknown variable" },
      ],
      details: { diagnosticCount: 1, errorCount: 1 },
    },
    { isPartial: false, expanded: false },
    theme,
    context,
  );
  assert.equal(
    plain(result),
    " ⚠ lsp check: src/app.ts · 1 diagnostic\n   L7:2 error[tsserver] unknown variable",
  );
  assert.ok(
    result.render(110).join("\n").includes(theme.fg("error", " ⚠ lsp check: ")),
  );
  assert.ok(result.render(110).join("\n").includes(theme.fg("error", "error")));
  assert.match(
    plain(
      renderLspResult(
        {
          content: [
            { type: "text", text: "L7:2 error[tsserver] unknown variable" },
          ],
        },
        { isPartial: false, expanded: false },
        theme,
        context,
      ),
    ),
    /^ ⚠ lsp check: src\/app\.ts · diagnostics reported/,
  );
  assert.equal(
    plain(
      renderLspResult(
        {
          content: [{ type: "text", text: "no diagnostics for src/app.ts" }],
          details: { diagnosticCount: 0 },
        },
        { isPartial: false, expanded: false },
        theme,
        context,
      ),
    ),
    " ✓ lsp check: src/app.ts · no diagnostics",
  );
  assert.match(
    plain(
      renderLspResult(
        { content: [{ type: "text", text: "no LSP session" }] },
        { isPartial: false, expanded: false },
        theme,
        { ...context, isError: true },
      ),
    ),
    /^ ✗ lsp check: no LSP session$/,
  );
});

test("registered repeat monitor stays visually active, and blocked command stays red", () => {
  const args = { description: "Check build", interval: 10 };
  const context = { args, isError: false };
  assert.equal(
    plain(renderRepeatCall(args, theme, { ...context, isPartial: true })),
    "⏳ Monitor: Check build (every 10s)",
  );
  assert.equal(
    plain(renderRepeatCall(args, theme, { ...context, isPartial: false })),
    "",
  );
  const result = renderRepeatResult(
    {
      content: [{ type: "text", text: "repeating PID=rpt-3 every 10s" }],
      details: {
        id: "rpt-3",
        description: "Check build",
        interval: 10,
        shuckWarnings: "shell warning",
      },
    },
    { isPartial: false },
    theme,
    context,
  );
  assert.equal(
    plain(result),
    "⏳ Monitor rpt-3: Check build · every 10s\n   ⚠ shell warning",
  );
  assert.ok(
    result.render(110).join("\n").includes(theme.fg("warning", "⏳ Monitor ")),
  );
  assert.equal(
    plain(
      renderRepeatResult(
        {
          content: [{ type: "text", text: "invalid interval" }],
          details: { blocked: "invalid interval" },
        },
        { isPartial: false },
        theme,
        { ...context, isError: true },
      ),
    ),
    "🛑 Blocked: Check build\n   - Reason: invalid interval",
  );
});
