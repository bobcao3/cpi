import assert from "node:assert/strict";

export function verify_render_context({
  host,
  tui,
  definition,
  result,
  script,
  work,
}) {
  const ui = new tui.TuiMainScreen(new tui.ProcessTerminal());
  ui.stop();
  const shell_call = result.details.calls.find(
    (call) =>
      result.details.cpi_calls[call.id]?.args.description === "Compact success",
  );
  const nested_duration =
    shell_call.durationMs < 1500
      ? `${Math.round(shell_call.durationMs)}ms`
      : `${Math.round(shell_call.durationMs / 1000)}s`;
  for (const padding of [0, 1, 3]) {
    const component = new host.ToolExecutionComponent(
      "codemode",
      "render-main",
      { code: script },
      { showImages: false, outputPad: padding },
      definition,
      ui,
      work,
    );
    const lines = () =>
      component
        .render(132)
        .map((line) => tui.stripTerminalSequences(line).trimEnd());
    component.updateResult({ ...result, durationMs: 9000 });
    const view = lines();
    const header = view.find((line) => line.includes("Code mode:"));
    assert(
      header.startsWith(`${" ".repeat(padding)} ✓ Code mode: JavaScript`),
      JSON.stringify(header),
    );
    assert.match(header, /9\.00s/);
    const nested = view.find((line) => line.includes("Compact success"));
    assert.equal(nested.match(/^ */)[0].length, padding + 1);
    assert(nested.endsWith(`(${nested_duration})`), nested);
    for (const width of [1, 2, 3, 12, 132])
      assert(
        component
          .render(width)
          .every((line) => tui.visibleWidth(line) <= width),
      );
    component.updateResult({ ...result, durationMs: undefined });
    assert.doesNotMatch(
      lines().find((line) => line.includes("Code mode:")),
      / · [\d.]+s/,
    );
  }
}
