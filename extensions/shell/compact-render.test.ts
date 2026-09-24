import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { killAll, runShell, setCurrentScope } from "./exec.ts";
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

test("shell durations use milliseconds below 1.5 seconds", () => {
  const args = { description: "Timing", waitfor: 30 };
  const context = { args, isError: false };
  for (const [elapsedMs, duration] of [
    [0, "0ms"],
    [1499, "1499ms"],
    [1500, "2s"],
  ] as const) {
    const details = { describe: args.description, elapsedMs, exitCode: 0 };
    assert.equal(
      plain(
        renderCompactShellResult(
          { details },
          { isPartial: false },
          theme,
          context,
        ),
      ),
      `✓ Ran shell: Timing (${duration})`,
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
      `⏳ Backgrounded shell: Timing (backgrounded after ${duration})`,
    );
  }
  const pending = renderCompactShellCall(
    args,
    theme,
    { isPartial: true, isError: false, state: { startedAt: Date.now() - 100 } },
    30,
  );
  assert.match(
    plain(pending),
    /^⏳ Running shell: Timing \(1\d\dms, wait for 30s\)$/,
  );
});

test("shell TUI shows only description and execution summary", async () => {
  const session = crypto.randomUUID();
  setCurrentScope(session);
  const args = {
    description: "Check shell summary",
    command: "printf 'secret-output\\nsecond\\n'",
    waitfor: 30,
  };
  const state = { startedAt: Date.now() - 5000 };
  const pending = renderCompactShellCall(
    args,
    theme,
    { isPartial: true, isError: false, state },
    30,
  );
  assert.equal(
    plain(pending),
    "⏳ Running shell: Check shell summary (5s, wait for 30s)",
  );
  assert.ok(
    pending
      .render(100)
      .join("\n")
      .includes(theme.fg("muted", " (5s, wait for 30s)")),
  );
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
    plain(
      renderCompactShellCall(
        args,
        theme,
        { isPartial: false, isError: false, state },
        30,
      ),
    ),
    "",
  );
  const startedAt = Date.now();
  const result = await runShell(
    args.command,
    args.waitfor,
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
    elapsedMs: Date.now() - startedAt,
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
  const duration =
    details.elapsedMs < 1500
      ? `${Math.round(details.elapsedMs)}ms`
      : `${Math.round(details.elapsedMs / 1000)}s`;
  const suffix = ` (${duration})`;
  assert.equal(rendered, `✓ Ran shell: Check shell summary${suffix}`);
  assert.ok(!rendered.includes("secret-output"));
  assert.ok(!rendered.includes(args.command));
  assert.ok(
    renderCompactShellResult({ details }, { isPartial: false }, theme, context)
      .render(100)
      .join("\n")
      .includes(theme.fg("muted", suffix)),
  );
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
    `⏳ Backgrounded shell: Check shell summary (backgrounded after ${duration})`,
  );
  const failed = plain(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
    ),
  );
  assert.equal(
    failed,
    `✗ Ran shell: Check shell summary\n  Exit 7 · 2 lines${suffix}`,
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

test("backgrounded shell shows time until backgrounding", async () => {
  const session = crypto.randomUUID();
  setCurrentScope(session);
  const args = { description: "Slow shell", command: "sleep 2", waitfor: 0.05 };
  const state: { startedAt?: number; timer?: ReturnType<typeof setInterval> } =
    {};
  let redraws = 0;
  const context = {
    args,
    isError: false,
    isPartial: true,
    executionStarted: true,
    state,
    invalidate: () => redraws++,
  };
  renderCompactShellCall(args, theme, context, 30);
  assert.ok(state.startedAt);
  assert.ok(state.timer);
  const startedAt = Date.now();
  try {
    const result = await runShell(
      args.command,
      args.waitfor,
      { ...process.env, PI_SESSION_ID: session },
      undefined,
      undefined,
      args.description,
      30,
      { maxLines: 100 },
      { previewMaxBytes: 8192, maxAcc: 8192, updateMs: 100 },
    );
    assert.equal(result.status, "running");
    const details = {
      ...result,
      describe: args.description,
      elapsedMs: Date.now() - startedAt,
    };
    const duration =
      details.elapsedMs < 1500
        ? `${Math.round(details.elapsedMs)}ms`
        : `${Math.round(details.elapsedMs / 1000)}s`;
    renderCompactShellCall(args, theme, { ...context, isPartial: false }, 30);
    assert.equal(state.timer, undefined);
    const rendered = renderCompactShellResult(
      { details },
      { isPartial: false },
      theme,
      context,
    );
    assert.equal(
      plain(rendered),
      `⏳ Backgrounded shell: Slow shell (backgrounded after ${duration})`,
    );
    assert.ok(
      rendered
        .render(100)
        .join("\n")
        .includes(theme.fg("muted", ` (backgrounded after ${duration})`)),
    );
    assert.equal(redraws, 0);
  } finally {
    if (state.timer) clearInterval(state.timer);
    killAll();
  }
});
