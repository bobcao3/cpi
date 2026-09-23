import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { runShell, setCurrentScope } from "./exec.ts";
import {
  renderCompactShellCall,
  renderCompactShellResult,
} from "./compact-render.ts";

const theme = getThemeByName("dark")!;
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(100)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");

test("shell TUI shows only description and execution summary", async () => {
  const session = crypto.randomUUID();
  setCurrentScope(session);
  const args = {
    description: "Check shell summary",
    command: "printf 'secret-output\\nsecond\\n'",
  };
  const pending = renderCompactShellCall(args, theme, { isPartial: true });
  assert.equal(plain(pending), "⏳ Running shell: Check shell summary");
  assert.ok(
    pending
      .render(100)
      .join("\n")
      .includes(
        theme.fg("warning", "⏳ Running shell: ") +
          theme.fg("text", args.description),
      ),
  );
  assert.equal(
    plain(renderCompactShellCall(args, theme, { isPartial: false })),
    "",
  );
  const result = await runShell(
    args.command,
    10,
    { ...process.env, PI_SESSION_ID: session },
    undefined,
    undefined,
    args.description,
    30,
    { maxLines: 100 },
    { previewMaxBytes: 8192, maxAcc: 8192, updateMs: 100 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputLines, 2);
  const details = {
    describe: args.description,
    status: result.status,
    exitCode: result.exitCode,
    outputLines: result.outputLines,
  };
  const context = { args, isError: false };
  assert.equal(
    plain(
      renderCompactShellResult(
        { details },
        { isPartial: true },
        theme,
        context,
      ),
    ),
    "",
  );
  const rendered = plain(
    renderCompactShellResult({ details }, { isPartial: false }, theme, context),
  );
  assert.equal(rendered, "✓ Ran shell: Check shell summary");
  assert.ok(!rendered.includes("secret-output"));
  assert.ok(!rendered.includes(args.command));
  assert.ok(
    renderCompactShellResult({ details }, { isPartial: false }, theme, context)
      .render(100)
      .join("\n")
      .includes(
        theme.fg("success", "✓ Ran shell: ") +
          theme.fg("text", args.description),
      ),
  );
  assert.equal(
    plain(
      renderCompactShellResult(
        { details: { ...details, status: "running" } },
        { isPartial: false },
        theme,
        context,
      ),
    ),
    "⏳ Backgrounded shell: Check shell summary",
  );
  const failed = plain(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
    ),
  );
  assert.equal(failed, "✗ Ran shell: Check shell summary\n  Exit 7 · 2 lines");
  assert.ok(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
    )
      .render(100)
      .join("\n")
      .includes(
        theme.fg("error", "✗ Ran shell: ") + theme.fg("text", args.description),
      ),
  );
  assert.ok(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
    )
      .render(100)
      .join("\n")
      .includes(theme.fg("error", "Exit 7")),
  );
});
