/**
 * goal — the /goal command + goal plumbing owner. Evaluation is owned by
 * core.ts / lib/anti-stuck.ts; this extension never runs the evaluator.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { loadText, textPath } from "./lib/text.ts";
import {
  GOAL_MSG_TYPE,
  clearGoal,
  getObjective,
  pauseGoal,
  reconstructGoal,
  renderGoalStatus,
  resumeGoal,
  setGoal,
} from "./lib/goal.ts";

interface GoalText {
  command: { description: string };
}

const CLEAR_ALIASES = new Set([
  "clear",
  "stop",
  "off",
  "reset",
  "none",
  "cancel",
]);
const SUBCOMMANDS = ["clear", "pause", "resume", "status"];

// sendUserMessage is fire-and-forget and yields before the turn arms, so
// poll until idle flips, then await the whole goal loop to settle.
async function awaitGoalLoop(ctx: ExtensionCommandContext): Promise<void> {
  for (let i = 0; i < 100 && ctx.isIdle(); i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  await ctx.waitForIdle();
}

export default function goalExtension(pi: ExtensionAPI): void {
  const T = loadText<GoalText>("goal", textPath("goal"));

  pi.registerMessageRenderer(GOAL_MSG_TYPE, (message, _options, theme) => {
    const d = (message.details ?? {}) as { kind?: string; objective?: string };
    const icon = d.kind === "stuck" ? "⏳" : "🎯";
    const obj = d.objective ? `: ${d.objective}` : "";
    return new Text(
      `${theme.fg("muted", icon)} ${theme.fg("muted", (d.kind ?? "goal") + obj)}`,
      0,
      0,
    );
  });

  pi.on("session_start", async (_e, ctx: ExtensionContext) =>
    reconstructGoal(ctx),
  );
  pi.on("session_tree", async (_e, ctx: ExtensionContext) =>
    reconstructGoal(ctx),
  );

  pi.registerCommand("goal", {
    description: T.command.description,
    getArgumentCompletions(prefix: string) {
      const p = prefix.toLowerCase();
      const items = SUBCOMMANDS.filter((s) => s.startsWith(p)).map((s) => ({
        value: s,
        label: s,
      }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx) => {
      const arg = args.trim();
      if (!arg) {
        ctx.ui.notify(renderGoalStatus(), "info");
        return;
      }
      const lower = arg.toLowerCase();
      if (CLEAR_ALIASES.has(lower)) {
        clearGoal(pi);
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }
      if (lower === "pause") {
        pauseGoal(pi);
        ctx.ui.notify("Goal paused. Use /goal resume to continue.", "info");
        return;
      }
      if (lower === "resume") {
        resumeGoal(pi);
        ctx.ui.notify("Goal resumed.", "info");
        if (ctx.isIdle()) {
          pi.sendUserMessage(`Continue working toward the active goal.`, {
            deliverAs: "followUp",
          });
          if (ctx.mode === "print" || ctx.mode === "json")
            await awaitGoalLoop(ctx);
        }
        return;
      }
      if (lower === "status") {
        ctx.ui.notify(renderGoalStatus(), "info");
        return;
      }
      setGoal(pi, arg);
      ctx.ui.notify(`Goal set: ${getObjective() ?? arg}`, "info");
      pi.sendUserMessage(arg, { deliverAs: "followUp" });
      if (ctx.mode === "print" || ctx.mode === "json") await awaitGoalLoop(ctx);
    },
  });
}
