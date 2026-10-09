import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  CustomMessageComponent,
  DefaultResourceLoader,
  SettingsManager,
  initTheme,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  NOTIFICATION_TYPE,
  registerNotificationRenderer,
  wrapNotification,
  type NotificationDetails,
} from "./notification.ts";

test("notification trees retain manual disclosures across host rebuilds", async () => {
  initTheme("dark");
  const directory = await mkdtemp(join(tmpdir(), "notification-test-"));
  try {
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory({}),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [registerNotificationRenderer],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const extension = loader.getExtensions().extensions[0];
    const renderer = extension?.messageRenderers.get(NOTIFICATION_TYPE);
    assert.ok(renderer);

    const summary =
      "Shell PID=123 · Verify 中文 command failed on exit 7; log /tmp/completion.log";
    const details: NotificationDetails = {
      kind: "shell-failed",
      summary,
      description: "Verify 中文",
      payload: { "shell-id": "123", "exit-code": 7, summary },
      log: { path: "/tmp/completion.log", startLine: 1, endLine: 80 },
    };
    const component = new CustomMessageComponent(
      {
        role: "custom",
        customType: NOTIFICATION_TYPE,
        timestamp: 1,
        display: true,
        details,
        content: wrapNotification(details),
      },
      renderer,
      undefined,
      3,
    );
    const lines = (width = 100) =>
      component.render(width).map(stripVTControlCharacters);
    const text = (width = 100) => lines(width).join("\n");
    const clickDisclosure = (row: string) => {
      const rendered = lines();
      const rowIndex = rendered.findIndex((line) => line.includes(row));
      assert.notEqual(rowIndex, -1);
      const markerIndex = rendered[rowIndex].search(/[▸▾]/);
      assert.notEqual(markerIndex, -1);
      component.handleMouse({
        x: markerIndex,
        y: rowIndex,
        button: "left",
        type: "click",
        screenX: markerIndex,
        screenY: rowIndex,
        width: 100,
        height: rendered.length,
        shift: false,
        alt: false,
        ctrl: false,
      });
    };

    let rendered = text();
    assert.ok(
      rendered.split("\n").some((line) => line.startsWith("× ▸ Shell")),
    );
    assert.ok(rendered.includes("exit 7"));
    assert.ok(!rendered.includes("/tmp/completion.log"));

    clickDisclosure("Shell");
    component.invalidate();
    rendered = text();
    assert.ok(rendered.includes("× ▾ Shell"));
    assert.ok(!rendered.includes("/tmp/completion.log"));

    clickDisclosure("Log");
    component.setOutputPad(1);
    rendered = text();
    assert.ok(rendered.includes("/tmp/completion.log"));
    for (const width of [1, 2, 3, 12, 100]) {
      assert.ok(lines(width).every((line) => visibleWidth(line) <= width));
    }

    component.setExpanded(true);
    assert.ok(text().includes('<notification type="shell-failed">'));
    component.setExpanded(false);
    rendered = text();
    assert.ok(
      rendered.split("\n").some((line) => line.startsWith("× ▸ Shell")),
    );
    assert.ok(!rendered.includes("/tmp/completion.log"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
