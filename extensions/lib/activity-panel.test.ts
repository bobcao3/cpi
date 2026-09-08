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

test("activity panel uses actual registry and log, bounds rendering, restores read-only close", async () => {
  const dir = await mkdtemp(join(tmpdir(), "activity-panel-"));
  const session_id = crypto.randomUUID();
  const id = crypto.randomUUID();
  const log_path = join(dir, "output.log");
  await writeFile(log_path, "first\nsecond\n\x1b[31mtail-output\x1b[0m\n");
  beginActivity({
    id,
    session_id,
    kind: "shell",
    status: "running",
    label: "actual\x1b[2J shell 界",
    log_path,
    started_at: Date.now(),
  });
  let closed = false;
  let wake: (() => void) | undefined;
  const theme = getThemeByName("dark")!;
  const panel = new ActivityPanel({
    session_id,
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
    assert.ok(output.includes(theme.italic("Recent output")));
    assert.ok(output.includes(theme.getBgAnsi("userMessageBg")));
    assert.ok(!output.includes(theme.getBgAnsi("customMessageBg")));
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
    assert.ok(text().includes("More details"));
    assert.ok(text().includes("ID:"));
    assert.ok(text().includes("tail-output"));
    panel.handleInput("\r");
    assert.ok(!text().includes("tail-output"));
    assert.ok(!text().includes("ID:"));
    assert.ok(!text().includes("\x1b[2J"));
    for (const width of [1, 2, 3, 8, 20, 80]) {
      const rows = panel.render(width);
      assert.ok(rows.length <= 32);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
    }
    panel.handleInput("\t");
    assert.ok(text().includes("actual"));
    panel.handleInput("\t");
    assert.ok(text().includes("No activity"));
    panel.handleInput("\x1b");
    assert.equal(closed, true);
    assert.deepEqual(panel.render(80), []);
  } finally {
    panel.dispose();
    finishActivity(id, "completed");
    await rm(dir, { recursive: true, force: true });
  }
});
