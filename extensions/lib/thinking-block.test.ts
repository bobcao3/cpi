import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import {
  getMarkdownTheme,
  initTheme,
} from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { AssistantMessageComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/assistant-message.js";
import { patchThinkingBlock, THINKING_LABEL } from "./thinking-block.ts";

initTheme("dark");

const render = (component: { render(width: number): string[] }) =>
  component
    .render(80)
    .map(stripVTControlCharacters)
    .map((line) => line.trimEnd());

const thinkingMessage = (label = THINKING_LABEL) =>
  new AssistantMessageComponent(
    {
      role: "assistant",
      content: [{ type: "thinking", thinking: "weighing options" }],
      stopReason: "toolUse",
    } as any,
    true,
    getMarkdownTheme(),
    label,
    1,
    [],
  );

test("collapsed thinking drops pi's italics and left padding", () => {
  // chalk is off when stdout is not a TTY, so emulate theme.italic's escapes.
  const label = `\x1b[3m${THINKING_LABEL}\x1b[23m`;
  assert.ok(thinkingMessage(label).render(80).join("\n").includes("\x1b[3m"));
  assert.deepEqual(render(thinkingMessage()), ["", ` ${THINKING_LABEL}`]);

  const seed = new AssistantMessageComponent(
    undefined,
    true,
    getMarkdownTheme(),
    THINKING_LABEL,
    1,
    [],
  );
  patchThinkingBlock({ children: [seed] });

  const patched = thinkingMessage(label).render(80).join("\n");
  assert.ok(!patched.includes("\x1b[3m"));
  assert.ok(!patched.includes("\x1b[23m"));
  assert.deepEqual(render(thinkingMessage(label)), ["", THINKING_LABEL]);
});
