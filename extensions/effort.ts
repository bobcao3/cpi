/**
 * effort — `/effort` command to tune thinking effort.
 *
 * Thin wrapper around `pi.setThinkingLevel` / `pi.getThinkingLevel`. The
 * model registry clamps the requested level to model capabilities
 * (non-reasoning models force "off"); we detect that by comparing the
 * requested level against `getThinkingLevel()` after the call and surface it,
 * so a silent clamp never confuses the user.
 *
 * Usage:
 *   /effort            show current thinking level
 *   /effort <level>    set level (off|minimal|low|medium|high|xhigh)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof LEVELS)[number];

const isLevel = (s: string): s is Level =>
  (LEVELS as readonly string[]).includes(s.toLowerCase());

export default function effortExtension(pi: ExtensionAPI): void {
  pi.registerCommand("effort", {
    description: `Tune thinking effort (no arg = show; levels: ${LEVELS.join("|")})`,

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

      // No arg: report current level.
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
        ctx.ui.notify(
          `Thinking effort: ${before} → ${after}`,
          "info",
        );
      } else {
        // Model clamped the request (e.g. non-reasoning model → "off").
        ctx.ui.notify(
          `Requested "${arg}" but model supports "${after}".`,
          "warning",
        );
      }
    },
  });
}
