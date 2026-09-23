import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ActivityPanel } from "./activity-panel.ts";
import { beginActivity, finishActivity } from "./activity.ts";
import { ensureTreeSitterReady } from "./tree-sitter.ts";
import "../shell/tools.ts";

test("activity panel uses actual registry and log, bounds rendering, restores read-only close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activity-panel-"));
  const session_id = crypto.randomUUID();
  const id = crypto.randomUUID();
  const next_id = crypto.randomUUID();
  const log_path = join(dir, "output.log");
  await writeFile(log_path, "first\nsecond\n\x1b[31mtail-output\x1b[0m\n");
  beginActivity({
    id,
    session_id,
    kind: "shell",
    status: "running",
    label: "actual\x1b[2J shell 界",
    command: "echo 'syntax-sample'\nprintf 'next-line'",
    cwd: "/tmp/panel-cwd",
    log_path,
    metrics: { output_bytes: 42, exit_code: 1 },
    started_at: Date.now(),
  });
  beginActivity({
    id: next_id,
    session_id,
    kind: "shell",
    status: "completed",
    label: "next session",
    started_at: Date.now() - 1000,
    ended_at: Date.now(),
  });
  let closed = false;
  let wake: (() => void) | undefined;
  const theme = getThemeByName("dark")!;
  const panel = new ActivityPanel({
    session_id,
    kind: "shell",
    theme,
    height: () => 40,
    requestRender: () => wake?.(),
    done: () => {
      closed = true;
    },
  });
  try {
    const text = () =>
      panel.render(100).map(stripVTControlCharacters).join("\n");
    assert.ok(text().includes("running actual shell 界 · Shell"));
    assert.ok(
      panel
        .render(100)
        .join("\n")
        .includes(theme.bold(theme.fg("text", "actual shell 界"))),
    );
    assert.ok(
      panel.render(100).join("\n").includes(theme.fg("success", "● running")),
    );
    assert.ok(!panel.render(100).join("\n").includes("\x1b[2J"));
    panel.handleInput("\r");
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    assert.ok(text().includes("tail-output"));
    const output = panel.render(100).join("\n");
    assert.ok(output.includes(theme.fg("muted", "tail-output")));
    assert.ok(output.includes(theme.italic("Recent outputs:")));
    assert.ok(text().includes("Command: echo 'syntax-sample' (+1 lines)"));
    assert.ok(text().includes("[+] ↵ show details"));
    assert.ok(!text().includes("next-line"));
    assert.ok(!text().includes("Dir: /tmp/panel-cwd"));
    const highlighted = await ensureTreeSitterReady();
    if (highlighted)
      assert.ok(
        panel
          .render(100)
          .join("\n")
          .includes(theme.fg("syntaxFunction", "echo")),
      );
    assert.ok(output.includes(theme.getBgAnsi("userMessageBg")));
    assert.ok(output.includes(theme.getBgAnsi("customMessageBg")));
    panel.handleInput("\x1b[D");
    assert.ok(text().includes("[ All ]"));
    panel.handleInput("\x1b[C");
    assert.ok(text().includes("[ Shell ]"));
    const rows = text().split("\n");
    const next_row = rows.findIndex((line) => line.includes("next session"));
    assert.ok(next_row > 0);
    assert.equal(rows[next_row - 1]!.replace(/[│ ]/g, ""), "");
    panel.handleMouse({
      type: "click",
      button: "left",
      x: 5,
      y: 2,
      screenX: 5,
      screenY: 2,
      width: 100,
      height: 32,
      shift: false,
      alt: false,
      ctrl: false,
    });
    assert.ok(text().includes("Command: echo 'syntax-sample'"));
    assert.ok(text().includes("printf 'next-line'"));
    assert.ok(!text().includes("(+1 lines)"));
    assert.ok(text().includes("Dir: /tmp/panel-cwd"));
    assert.ok(text().includes("More details"));
    assert.ok(text().includes("Log: "));
    assert.ok(text().includes("Started: "));
    assert.ok(text().includes("ID: "));
    assert.ok(text().includes("output bytes: 42"));
    assert.ok(text().includes("exit code: 1"));
    if (highlighted)
      assert.ok(
        panel
          .render(100)
          .join("\n")
          .includes(theme.fg("syntaxFunction", "echo")),
      );
    assert.ok(!text().includes("[+] ↵ show details"));
    assert.ok(text().includes("tail-output"));
    panel.handleInput("\r");
    assert.ok(!text().includes("tail-output"));
    assert.ok(!text().includes("Command: echo 'syntax-sample'"));
    assert.ok(!text().includes("\x1b[2J"));
    for (const width of [1, 2, 3, 8, 20, 80]) {
      const rows = panel.render(width);
      assert.ok(rows.length <= 32);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
    }
    panel.handleInput("\x1b[D");
    panel.handleInput("\t");
    assert.ok(text().includes("actual"));
    panel.handleInput("\t");
    assert.ok(text().includes("No activity"));
    panel.handleInput("\x1b");
    assert.equal(closed, true);
    assert.deepEqual(panel.render(80), []);
    let q_closed = false;
    const q_panel = new ActivityPanel({
      session_id,
      kind: "shell",
      theme,
      height: () => 40,
      requestRender: () => {},
      done: () => {
        q_closed = true;
      },
    });
    q_panel.handleInput("q");
    assert.equal(q_closed, true);
    assert.deepEqual(q_panel.render(80), []);
  } finally {
    panel.dispose();
    finishActivity(id, "completed");
    await rm(dir, { recursive: true, force: true });
  }
});

test("condensed shell command stays on one row when long", () => {
  const session_id = crypto.randomUUID();
  const id = crypto.randomUUID();
  beginActivity({
    id,
    session_id,
    kind: "shell",
    status: "completed",
    label: "Long command",
    command: `echo ${"x".repeat(200)}\necho second`,
    cwd: "/tmp/activity",
    started_at: Date.now(),
  });
  const panel = new ActivityPanel({
    session_id,
    kind: "shell",
    theme: getThemeByName("dark")!,
    height: () => 40,
    requestRender: () => {},
    done: () => {},
  });
  try {
    panel.handleInput("\r");
    const rows = panel.render(48).map(stripVTControlCharacters);
    assert.equal(rows.filter((row) => row.includes("Command:")).length, 1);
    assert.ok(rows.some((row) => row.includes("(+1 lines)")));
    assert.ok(!rows.some((row) => row.includes("echo second")));
    panel.handleInput("\r");
    const expanded = panel.render(48).map(stripVTControlCharacters).join("\n");
    assert.ok(expanded.includes("echo second"));
    assert.ok(expanded.includes("Dir: /tmp/activity"));
  } finally {
    panel.dispose();
  }
});
