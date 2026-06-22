/**
 * goal — the /goal slash command + the goal plumbing owner.
 *
 * Sole owner of the `/goal` command, the "goal-message" renderer, and
 * goal-state reconstruction on session start/tree.
 * The two evaluation points (agent completion + stuck-check merge) are owned
 * by core.ts and lib/anti-stuck.ts respectively — they call lib/goal.ts. This
 * extension only registers the command/renderer and reconstructs
 * state; it never runs the evaluator or continuation itself, so a hot-reload
 * re-registers the surface without disturbing in-flight goal state on the
 * globalThis slot (per AGENTS.md: unconditional register at load, sole owner).
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

const CLEAR_ALIASES = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
const SUBCOMMANDS = ["clear", "pause", "resume", "status"];

// sendUserMessage is fire-and-forget (void) and yields before the turn arms
// (it awaits _checkCompaction before _runAgentPrompt), so waitForIdle called
// immediately would see idle and return before the loop starts — so poll up
// to ~1s until the turn arms (ctx.isIdle() false), then await ctx.waitForIdle()
// to wait for the whole goal loop to settle.
async function awaitGoalLoop(ctx: ExtensionCommandContext): Promise<void> {
  for (let i = 0; i < 100 && ctx.isIdle(); i++) {
    await new Promise<void>((r) => setTimeout(r, 10));
  }
  await ctx.waitForIdle();
}

export default function goalExtension(pi: ExtensionAPI): void {
  const T = loadText<GoalText>("goal", textPath("goal"));

  // Renderer for goal-messages (continuation / stuck) shown in the TUI. The
  // content is a CustomMessage (in LLM context) regardless of the renderer.
  pi.registerMessageRenderer(GOAL_MSG_TYPE, (message, _options, theme) => {
    const d = (message.details ?? {}) as { kind?: string; objective?: string };
    const icon = d.kind === "stuck" ? "⏳" : "🎯";
    const obj = d.objective ? `: ${d.objective}` : "";
    return new Text(`${theme.fg("muted", icon)} ${theme.fg("muted", (d.kind ?? "goal") + obj)}`, 0, 0);
  });

  // Reconstruct goal state from the session on start / tree navigation.
  pi.on("session_start", async (_e, ctx: ExtensionContext) => reconstructGoal(ctx));
  pi.on("session_tree", async (_e, ctx: ExtensionContext) => reconstructGoal(ctx));

  pi.registerCommand("goal", {
    description: T.command.description,
    getArgumentCompletions(prefix: string) {
      const p = prefix.toLowerCase();
      const items = SUBCOMMANDS.filter((s) => s.startsWith(p)).map((s) => ({ value: s, label: s }));
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
        // If idle, kick a turn so the loop restarts (the active goal is carried by
        // the conversation). Queued as a steer if the agent is streaming.
        if (ctx.isIdle()) {
          pi.sendUserMessage(`Continue working toward the active goal.`, { deliverAs: "followUp" });
          if (ctx.mode === "print" || ctx.mode === "json") await awaitGoalLoop(ctx);
        }
        return;
      }
      if (lower === "status") {
        ctx.ui.notify(renderGoalStatus(), "info");
        return;
      }
      // Set a new goal (replaces any active one) and start the first turn with
      // the objective as the directive. sendUserMessage starts turn 1; the goal
      // loop then runs as turn 1's flat agent-loop continuation (the evaluator
      // fires at each agent_end via core.ts).
      setGoal(pi, arg);
      ctx.ui.notify(`Goal set: ${getObjective() ?? arg}`, "info");
      pi.sendUserMessage(arg, { deliverAs: "followUp" });
      if (ctx.mode === "print" || ctx.mode === "json") await awaitGoalLoop(ctx);
    },
  });
}
