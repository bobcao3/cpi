import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
  NOTIFICATION_TYPE,
  registerNotificationRenderer,
  type NotificationKind,
} from "./notification.ts";

const theme = getThemeByName("dark")!;

const KINDS: NotificationKind[] = [
  "external-event",
  "alarm",
  "shell-complete",
  "shell-failed",
  "repeat-stopped",
  "repeat-breach",
  "model-change",
  "orphaned-shells",
  "completed-shells",
];

function capturedRenderer() {
  let renderer: any;
  registerNotificationRenderer({
    on: () => {},
    registerMessageRenderer: (_type: string, fn: unknown) => {
      renderer = fn;
    },
  } as any);
  return renderer;
}

test("compact notifications align their summary past a two-column icon", () => {
  const renderer = capturedRenderer();
  const summary = "Shell 2944429 completed on exit 0";
  for (const kind of KINDS) {
    const line = renderer(
      {
        customType: NOTIFICATION_TYPE,
        timestamp: 1,
        content: "<notification/>",
        details: { kind, summary, payload: {} },
      },
      {},
      theme,
    )
      .render(100)
      .map(stripVTControlCharacters)
      .join("\n");
    const index = line.indexOf(summary);
    assert.equal(
      visibleWidth(line.slice(0, index)),
      3,
      `${kind} rendered as ${JSON.stringify(line)}`,
    );
  }
});
