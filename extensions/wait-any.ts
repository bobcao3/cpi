/** wait_any — placebo: terminates the turn; the next event (user message, background completion, alarm) wakes the agent. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  loadText,
  render,
  renderLines,
  textPath,
  type ToolText,
} from "./lib/text.ts";

const WAIT_ANY_TOOL = "wait_any";

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
      // Content MUST be non-empty: an empty toolResult renders as "(see
      // attached image)", making the model believe it received an image.
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
      const t =
        (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      t.setText(
        theme.fg("muted", "💤") +
          theme.fg("dim", " waiting on events or user input"),
      );
      return t;
    },
  });
}
