/**
 * cpi core — sole owner of all shared cpi plumbing; producers are pure
 * clients of lib/*, registration unconditional at load.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { applySystemPromptTransforms } from "./lib/system-prompt.ts";
import { buildCpiSystemPrompt } from "./lib/system-prompt-build.ts";
import { modelSupportsVision } from "./lib/media.ts";
import { drainAfterTool, drainBeforeUser } from "./lib/prepend-message.ts";
import { registerNotificationRenderer } from "./lib/notification.ts";
import {
  setupCpiFooter,
  disposeCpiFooter,
  registerRightSegment,
} from "./lib/footer.ts";
import { setSessionDir } from "./lib/session-dir.ts";
import { getSubagentUsage, resetSubagentUsage } from "./lib/cost-ledger.ts";
import {
  awaitHoldInterval,
  doubleHoldInterval,
  getHoldInterval,
  getHoldSources,
  getLastStopReason,
  resetHoldInterval,
  resetHoldTracking,
  setLastStopReason,
} from "./lib/session-hold.ts";
import {
  armAntiStuckTimer,
  disarmAntiStuckTimer,
  markEventlessStart,
  resetAntiStuck,
} from "./lib/anti-stuck.ts";
import {
  achieveGoal,
  budgetPauseGoal,
  continueGoal,
  evaluateGoal,
  isGoalActive,
} from "./lib/goal.ts";

export default function coreExtension(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    setupCpiFooter(pi, ctx);
    setSessionDir(ctx.sessionManager?.getSessionDir());
    resetSubagentUsage();
    registerRightSegment("subagent-cost", costSegment);
    // A session switch (new/resume/fork/tree) ends any in-flight stuck wait.
    resetAntiStuck();
    disarmAntiStuckTimer();
  });
  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    setupCpiFooter(pi, ctx);
    registerRightSegment("subagent-cost", costSegment);
  });
  pi.on("session_shutdown", async () => {
    disposeCpiFooter();
  });

  registerNotificationRenderer(pi);

  pi.on("before_agent_start", () => drainBeforeUser(pi));
  pi.on("tool_execution_end", () => drainAfterTool(pi));

  // Sole systemPrompt return across cpi — no other handler returns one.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    return {
      systemPrompt: applySystemPromptTransforms(
        buildCpiSystemPrompt(event.systemPromptOptions, {
          vision: modelSupportsVision(ctx?.model),
        }),
        ctx,
        event.systemPromptOptions,
      ),
    };
  });

  // The hold is a pure keep-alive; probing stuck waits and appending
  // corrective messages is the anti-stuck timer's job, armed here in both modes.
  pi.on("agent_start", () => {
    resetHoldTracking();
    // Every turn is a real event (input, completion, alarm, abort) — disarm the stuck clock.
    disarmAntiStuckTimer();
    resetAntiStuck();
  });

  pi.on("agent_end", async (event: any, ctx: any) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m.role === "assistant") {
        setLastStopReason(m.stopReason);
        break;
      }
    }
    const reason = getLastStopReason();
    if (reason === "error" || reason === "aborted") return;
    const sources = getHoldSources();
    const pending = sources.filter((s) => s.hasPending());
    if (isGoalActive() && pending.length === 0) {
      if (ctx.hasUI) ctx.ui.setWidget("goal-eval", ["🎯 Evaluating goal…"]);
      try {
        const v = await evaluateGoal(pi, ctx);
        if (v.status === "met") {
          achieveGoal(pi, ctx);
          return;
        }
        if (v.status === "failed") {
          budgetPauseGoal(pi, ctx, v.reason);
          return;
        }
        continueGoal(pi, ctx, v.reason);
        return;
      } finally {
        if (ctx.hasUI) ctx.ui.setWidget("goal-eval", undefined);
      }
    }
    if (pending.length === 0) return;
    const pendingAlarm = pending.some((s) => s.id === "alarm");
    const pendingNonAlarm = pending.some((s) => s.id !== "alarm");
    // An alarm is a deterministic wakeup, so don't arm the anti-stuck timer.
    if (pendingNonAlarm && !pendingAlarm) {
      markEventlessStart();
      armAntiStuckTimer(pi, ctx);
    }
    if (ctx.hasUI) return;
    let fired = await awaitHoldInterval(sources, getHoldInterval());
    while (!fired) {
      doubleHoldInterval();
      fired = await awaitHoldInterval(sources, getHoldInterval());
    }
    resetHoldInterval();
    disarmAntiStuckTimer();
    resetAntiStuck();
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    const reason = getLastStopReason();
    const sources = getHoldSources();
    const abortAll = () => {
      for (const s of sources) {
        try {
          s.onAbort();
        } catch {
          // onAbort is best-effort; never let one failure skip the rest.
        }
      }
    };
    if (
      ctx.hasUI ||
      event.reason !== "quit" ||
      reason === "error" ||
      reason === "aborted"
    ) {
      abortAll();
      return;
    }
    const pending = sources.filter((s) => s.hasPending());
    if (pending.length === 0) {
      abortAll();
      return;
    }
    const deadline = Date.now() + Math.max(...pending.map((s) => s.deadlineMs));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (Date.now() >= deadline) return resolve();
        const still = sources.some((s) => s.hasPending());
        if (!still && ctx.isIdle()) {
          // Grace beat: confirm no follow-up turn is starting before resolving.
          setTimeout(
            () =>
              sources.some((s) => s.hasPending()) || !ctx.isIdle()
                ? setTimeout(check, 100)
                : resolve(),
            500,
          );
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
    abortAll();
  });
}

function costSegment(): string | undefined {
  const u = getSubagentUsage();
  if (u.count === 0) return undefined;
  return `sub $${u.cost.toFixed(4)}·${u.count}`;
}
