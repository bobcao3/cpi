/**
 * `/effort` — tune thinking effort; compares requested vs resulting level so
 * a silent model clamp (non-reasoning → "off") never confuses the user.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadText, render, textPath, type ToolText } from "./lib/text.ts";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

const isLevel = (s: string): s is Level =>
  (LEVELS as readonly string[]).includes(s.toLowerCase());

export default function effortExtension(pi: ExtensionAPI): void {
  const T = loadText<ToolText>("effort", textPath("effort"));
  const levels = LEVELS.join("|");

  pi.registerCommand("effort", {
    description: render(T.tool.description, { levels }),

    getArgumentCompletions(prefix: string) {
      const p = prefix.toLowerCase();
      const items = LEVELS.filter((l) => l.startsWith(p)).map((l) => ({
        value: l,
        label: l,
      }));
      return items.length > 0 ? items : null;
    },

    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();

      if (!arg) {
        ctx.ui.notify(`Thinking effort: ${pi.getThinkingLevel()}`, "info");
        return;
      }

      if (!isLevel(arg)) {
        ctx.ui.notify(
          `Unknown effort "${arg}". Levels: ${LEVELS.join(", ")}.`,
          "error",
        );
        return;
      }

      const before = pi.getThinkingLevel();
      pi.setThinkingLevel(arg);
      const after = pi.getThinkingLevel();

      if (after === arg) {
        ctx.ui.notify(`Thinking effort: ${before} → ${after}`, "info");
      } else {
        ctx.ui.notify(
          `Requested "${arg}" but model supports "${after}".`,
          "warning",
        );
      }
    },
  });
}
