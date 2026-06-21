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
 * header). `renderResult` is intentionally omitted: `execute` returns empty
 * content (`text: ""`), so the built-in `createResultFallback` returns
 * `undefined` and no result line is added — netting a single message line.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { loadText, render, textPath, type ToolText } from "./lib/text.ts";

const WAIT_ANY_TOOL = "wait_any";

export default function waitAnyExtension(pi: ExtensionAPI): void {
  const T = loadText<ToolText>("wait-any", textPath("wait-any"));
  const guidelines = render(T.guidelines.bullets, {}).split("\n");
  pi.registerTool({
    name: WAIT_ANY_TOOL,
    label: "Wait (any event)",
    description: render(T.tool.description, {}),
    promptSnippet: T.tool.prompt_snippet,
    promptGuidelines: guidelines,
    parameters: Type.Object({}),
    async execute() {
      return {
        content: [
          {
            type: "text",
            text: "",
          },
        ],
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
