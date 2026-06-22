/**
 * wait_any — a placebo tool that yields control.
 *
 * Returns `terminate: true` so the agent stops after calling it (the agent loop
 * emits `agent_end` once the tool batch terminates — see agent-loop.js
 * `shouldTerminateToolBatch`). The turn ends; the agent is then woken by the next
 * event: a user message, a background shell completion or error, or an alarm
 * wakeup. The session stays alive while background work is pending via the
 * headless `agent_end` hold (lib/session-hold.ts `awaitPendingHolds`) and pi's
 * notification-driven turn triggering — so yielding replaces polling.
 *
 * Sole owner of the `wait_any` tool: registers unconditionally at load.
 * `pi.registerTool` is an idempotent `Map.set` on the fresh per-instance map
 * (per AGENTS.md), so no `globalThis` dedup flag is used.
 *
 * Rendering: uses `renderShell: "self"` so the tool renders its own framing
 * (no Box padding/bg) as a plain oneliner, matching skill.ts house style. Only
 * `renderCall` returns the message line (also overriding the default tool-name
 * header). `renderResult` is intentionally omitted, but because `execute` now
 * returns non-empty content (a wall-clock timestamp), the built-in
 * `createResultFallback` renders a compact result line showing the time — so the
 * tool produces a call line followed by a result line rather than a single line.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadText, render, renderLines, textPath, type ToolText } from "./lib/text.ts";

const WAIT_ANY_TOOL = "wait_any";

/**
 * Compact wall-clock timestamp: "DD/MM/YY h:mm AM/PM".
 *
 * Day and month are zero-padded to 2 digits; year is 2 digits; hour is 12-hour
 * with no leading zero (0 mapped to 12); minutes zero-padded to 2 digits;
 * AM/PM is uppercase. Example output: "26/06/21 9:04 PM".
 */
function nowTimestamp(): string {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear() % 100).padStart(2, "0");
  let hours = d.getHours();
  const ampm = hours >= 12 ? "PM" : "AM";
  hours = hours % 12;
  if (hours === 0) hours = 12;
  const minutes = String(d.getMinutes()).padStart(2, "0");
  return `${day}/${month}/${year} ${hours}:${minutes} ${ampm}`;
}

export default function waitAnyExtension(pi: ExtensionAPI): void {
  const T = loadText<ToolText>("wait-any", textPath("wait-any"));
  const guidelines = renderLines(T.guidelines.bullets, {});
  pi.registerTool({
    name: WAIT_ANY_TOOL,
    label: "Wait (any event)",
    description: render(T.tool.description, {}),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      // Content MUST be non-empty: pi-ai's openai-completions `convertMessages`
      // maps a toolResult whose text is empty and which has no image blocks to
      // the literal string "(see attached image)" — a fallback meant for
      // image-only results. An empty wait_any result would make the model
      // believe it received an image (observed in tb21-cpi-kimi-c8: "wait_any
      // returned with attached image, not text"). Returning the current time
      // also anchors the model after long holds.
      return {
        content: [
          {
            type: "text",
            text: nowTimestamp(),
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
    renderShell: "self",
    renderCall(_args, theme, context) {
      const t = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(theme.fg("muted", "💤") + theme.fg("dim", " waiting on events or user input"));
      return t;
    },
  });
}
