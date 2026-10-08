import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import { killAll, runShell, setCurrentScope } from "./exec.ts";
import {
  renderCompactBackgroundPsResult,
  renderCompactShellCall,
  renderCompactShellResult,
  renderCompactSignalResult,
} from "./compact-render.ts";

const theme = getThemeByName("dark")!;
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(100)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");

test("shell durations use milliseconds below 1.5 seconds", () => {
  const args = { description: "Timing", waitfor: 30 };
  for (const [durationMs, duration] of [
    [undefined, undefined],
    [0, "0ms"],
    [1499, "1499ms"],
    [1500, "2s"],
  ] as const) {
    const details = {
      describe: args.description,
      elapsedMs: 999999,
      exitCode: 0,
    };
    const context = { args, isError: false, durationMs };
    assert.equal(
      plain(
        renderCompactShellResult(
          { details },
          { isPartial: false },
          theme,
          context,
          "bash",
        ),
      ),
      ` ✓ bash: Timing${duration === undefined ? "" : ` (${duration})`}`,
    );
  }
  const pending = renderCompactShellCall(
    args,
    theme,
    { isPartial: true, isError: false, state: { startedAt: Date.now() - 100 } },
    30,
    "bash",
  );
  assert.match(plain(pending), /^⏳ bash: Timing \(1\d\dms, wait for 30s\)$/);
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
    "bash",
  );
  assert.equal(
    plain(pending),
    "⏳ bash: Check shell summary (5s, wait for 30s)",
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
        theme.fg("warning", "⏳ bash: ") + theme.fg("dim", args.description),
      ),
  );
  assert.equal(
    plain(
      renderCompactShellCall(
        args,
        theme,
        { isPartial: false, isError: false, state },
        30,
        "bash",
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
    shellName: "bash",
    status: result.status,
    exitCode: result.exitCode,
    outputLines: result.outputLines,
  };
  const durationMs = Date.now() - startedAt;
  const context = { args, isError: false, durationMs };
  assert.equal(
    plain(
      renderCompactShellResult(
        { details },
        { isPartial: true },
        theme,
        context,
        "bash",
      ),
    ),
    "",
  );
  const rendered = plain(
    renderCompactShellResult(
      { details },
      { isPartial: false },
      theme,
      context,
      "bash",
    ),
  );
  const duration =
    durationMs < 1500
      ? `${Math.round(durationMs)}ms`
      : `${Math.round(durationMs / 1000)}s`;
  const suffix = ` (${duration})`;
  assert.equal(rendered, ` ✓ bash: Check shell summary${suffix}`);
  assert.equal(
    plain(
      renderCompactShellResult(
        { details: { ...details, shellName: "zsh" } },
        { isPartial: false },
        theme,
        context,
        "bash",
      ),
    ),
    ` ✓ zsh: Check shell summary${suffix}`,
  );
  assert.ok(!rendered.includes("secret-output"));
  assert.ok(!rendered.includes(args.command));
  assert.ok(
    renderCompactShellResult(
      { details },
      { isPartial: false },
      theme,
      context,
      "bash",
    )
      .render(100)
      .join("\n")
      .includes(theme.fg("muted", suffix)),
  );
  assert.ok(
    renderCompactShellResult(
      { details },
      { isPartial: false },
      theme,
      context,
      "bash",
    )
      .render(100)
      .join("\n")
      .includes(
        theme.fg("success", " ✓ bash: ") + theme.fg("dim", args.description),
      ),
  );
  const failed = plain(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
      "bash",
    ),
  );
  assert.equal(
    failed,
    ` ✗ bash: Check shell summary\n   Exit 7 · 2 lines${suffix}`,
  );
  assert.ok(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
      "bash",
    )
      .render(100)
      .join("\n")
      .includes(
        theme.fg("error", " ✗ bash: ") + theme.fg("dim", args.description),
      ),
  );
  assert.ok(
    renderCompactShellResult(
      { details: { ...details, exitCode: 7 } },
      { isPartial: false },
      theme,
      { ...context, isError: true },
      "bash",
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
  renderCompactShellCall(args, theme, context, 30, "bash");
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
    assert.ok(result.id);
    const details = {
      ...result,
      describe: args.description,
      shellName: "bash",
    };
    const durationMs = Date.now() - startedAt;
    const duration =
      durationMs < 1500
        ? `${Math.round(durationMs)}ms`
        : `${Math.round(durationMs / 1000)}s`;
    renderCompactShellCall(
      args,
      theme,
      { ...context, isPartial: false },
      30,
      "bash",
    );
    assert.equal(state.timer, undefined);
    const rendered = renderCompactShellResult(
      { details },
      { isPartial: false },
      theme,
      { ...context, isPartial: false, durationMs },
      "bash",
    );
    assert.equal(
      plain(rendered),
      `⏳ backgrounded bash: PID=${result.id} · Slow shell (backgrounded after ${duration})`,
    );
    assert.ok(
      rendered
        .render(100)
        .join("\n")
        .includes(theme.fg("warning", "⏳ backgrounded bash: ")),
    );
    assert.ok(
      rendered
        .render(100)
        .join("\n")
        .includes(
          `\x1b[2m${theme.fg("warning", `PID=${result.id}`)}\x1b[22m${theme.fg("dim", " · Slow shell")}`,
        ),
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

test("signal and background-ps use compact unboxed style", () => {
  const faintPid = `\x1b[2m${theme.fg("warning", "PID=abc123")}\x1b[22m`;
  const signal = renderCompactSignalResult(
    { details: { id: "abc123", signal: "SIGINT", describe: "watch logs" } },
    { isPartial: false },
    theme,
    { args: {}, isError: false },
  );
  assert.equal(plain(signal), " → Sent SIGINT to PID=abc123 · watch logs");
  const signalRaw = signal.render(100).join("\n");
  assert.ok(signalRaw.includes(theme.fg("text", " → Sent SIGINT to ")));
  assert.ok(signalRaw.includes(faintPid));
  assert.ok(signalRaw.includes(theme.fg("dim", " · watch logs")));
  assert.equal(
    plain(
      renderCompactSignalResult(
        { details: { id: "abc123", signal: "SIGKILL" } },
        { isPartial: false },
        theme,
        { args: {}, isError: false },
      ),
    ),
    " → Sent SIGKILL to PID=abc123",
  );
  const ps = renderCompactBackgroundPsResult(
    {
      details: {
        backgrounds: [{ id: "abc123", describe: "watch logs" }],
        repeats: [{ id: "rpt-1", describe: "poll api" }],
      },
    },
    { isPartial: false },
    theme,
  );
  assert.equal(
    plain(ps),
    " ○ Listed background shells:\n" +
      "   ├─ PID=abc123 · watch logs\n" +
      "   └─ rpt-1 [repeating] poll api",
  );
  const psRaw = ps.render(100).join("\n");
  assert.ok(psRaw.includes(theme.fg("text", " ○ Listed background shells:")));
  assert.ok(psRaw.includes(faintPid));
  assert.ok(psRaw.includes(theme.fg("dim", "   ├─ ")));
  assert.ok(psRaw.includes(theme.fg("dim", "   └─ ")));
  assert.ok(psRaw.includes(theme.fg("accent", " [repeating]")));
  assert.equal(
    plain(
      renderCompactBackgroundPsResult(
        { details: undefined },
        { isPartial: false },
        theme,
      ),
    ),
    " ○ No background shells",
  );
});
