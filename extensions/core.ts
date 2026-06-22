/**
 * cpi core — the single owner extension for all shared cpi plumbing.
 *
 * Bundles the five per-instance "owners" that previously lived as separate
 * thin extensions (system-prompt, prepend-message, notification, hold, footer).
 * Each owns a piece of process-wide plumbing whose producers (shell, alarm,
 * cwd, skill, caveman-micro, vcs-jj, …) are *clients* — they only call into
 * `lib/*` and never register handlers/renderers themselves.
 *
 * Why bundle the owners into one extension instead of N:
 *
 *   - Coherence: a producer without its owner is silently broken (pi falls
 *     back to raw `[customType]` + content, or queued messages never drain).
 *     When owner + producers are scattered across independent files, removing
 *     one owner file disables every producer. One core file means the plumbing
 *     is present iff cpi is present at all — no dangling halves.
 *   - Hot-reload soundness (per AGENTS.md): each owner re-registers on its own
 *     extension instance at load (`pi.on` / `registerMessageRenderer` are
 *     idempotent `Map.set` / append on a fresh instance). Bundling means a
 *     single reload re-registers ALL owners atomically — strictly stronger
 *     than five independent reloads. No `globalThis` dedup flag is used (the
 *     anti-pattern): registration is unconditional at load.
 *   - Shared mutable state still lives in `lib/*` on `globalThis` slots
 *     (footer singleton, prepend queues, hold registry, system-prompt
 *     transform registry). Reloads re-populate it; it is never used to skip
 *     registration.
 *
 * Producers must NOT register any of these owners; they call `lib/*` only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applySystemPromptTransforms } from "./lib/system-prompt.ts";
import { buildCpiSystemPrompt } from "./lib/system-prompt-build.ts";
import { modelSupportsVision } from "./lib/media.ts";
import { drainAfterTool, drainBeforeUser } from "./lib/prepend-message.ts";
import { registerNotificationRenderer } from "./lib/notification.ts";
import { setupCpiFooter, disposeCpiFooter, registerRightSegment } from "./lib/footer.ts";
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
  // ── Footer owner ────────────────────────────────────────────────────────
  // Owns pi's custom footer for all cpi extensions. Contributors (vcs-jj,
  // caveman-micro, shell/status) push data via lib/footer.ts; they never
  // call setFooter. Re-setup on session_start/tree is idempotent.
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

  // ── Notification renderer owner ────────────────────────────────────────
  // Owns the <notification> message renderer. Senders (shell/alarm/hold) use
  // `sendNotification` from lib/notification.ts; they never register.
  registerNotificationRenderer(pi);

  // ── Prepend-message drain owner ────────────────────────────────────────
  // Owns the two drain points for the queued-message plumbing. Producers
  // (cwd, skill, caveman-micro) only `queueMessage()`; they never install
  // handlers.
  pi.on("before_agent_start", () => drainBeforeUser(pi));
  pi.on("tool_execution_end", () => drainAfterTool(pi));

  // ── System-prompt owner ────────────────────────────────────────────────
  // The SINGLE before_agent_start handler that returns a mutated
  // systemPrompt, after applying every registered transform (from skill,
  // caveman-micro, …) in declared `order`. No other handler here returns a
  // value, so this is the sole systemPrompt return across all of cpi.
  // The prompt is built from scratch via buildCpiSystemPrompt, which fully
  // replaces pi-core's buildSystemPrompt (drops redundant tool listing, uses
  // live cwd); transforms are then applied on top of that cpi-built prompt.
  pi.on("before_agent_start", async (event: any, ctx: any) => {
    return {
      systemPrompt: applySystemPromptTransforms(
        buildCpiSystemPrompt(event.systemPromptOptions, { vision: modelSupportsVision(ctx?.model) }),
        ctx,
        event.systemPromptOptions,
      ),
    };
  });

  // ── Session-hold owner ─────────────────────────────────────────────────
  // The SINGLE extension that owns hold logic. The hold is now a PURE
  // keep-alive mechanism: in headless mode it stays alive until a pending
  // source fires (no notifications/messages); in TUI mode the UI stays alive
  // on its own. The "tell the agent" role — probing a stuck wait and
  // appending a corrective message — is owned by the anti-stuck timer
  // (lib/anti-stuck.ts), which is armed here in BOTH modes. Sources only
  // `registerHoldSource` + own their `onAbort` cleanup; they never run hold
  // awaits or emit messages.
  pi.on("agent_start", () => {
    resetHoldTracking();
    // With hold reminders gone, every turn is a real event (user input,
    // background completion, alarm fire, or an anti-stuck abort), so disarm
    // and reset the stuck clock in both TUI and headless.
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
    // Case 1 — agent completion, no pending backgrounds: the fork-probe
    // evaluator decides whether the goal is met, not-met (continue), or
    // failed (budget-pause).
    if (isGoalActive() && pending.length === 0) {
      if (ctx.hasUI) ctx.ui.setWidget("goal-eval", ["🎯 Evaluating goal…"]);
      try {
        const v = await evaluateGoal(pi, ctx);
        if (v.status === "met") { achieveGoal(pi, ctx); return; }
        if (v.status === "failed") { budgetPauseGoal(pi, ctx, v.reason); return; }
        continueGoal(pi, ctx, v.reason); return;
      } finally {
        if (ctx.hasUI) ctx.ui.setWidget("goal-eval", undefined);
      }
    }
    if (pending.length === 0) return;
    const pendingAlarm = pending.some((s) => s.id === "alarm");
    const pendingNonAlarm = pending.some((s) => s.id !== "alarm");
    // Arms the anti-stuck escalation timer in BOTH TUI and headless — it now
    // owns the "tell the agent" role; the hold is a pure keep-alive with no
    // notifications. An alarm is a deterministic wakeup, so we don't arm when
    // one is upcoming.
    if (pendingNonAlarm && !pendingAlarm) {
      markEventlessStart();
      armAntiStuckTimer(pi, ctx);
    }
    // TUI stays alive on its own; the anti-stuck timer escalates.
    if (ctx.hasUI) return;
    // Headless pure keep-alive: stay alive until a pending source fires with no
    // messages. The anti-stuck timer handles escalation and on ABORT calls
    // signalHoldEvent() to release this loop so the appended turn can run. The
    // doubling poll interval makes a long idle cheap while a real event
    // resolves the await immediately.
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
    if (ctx.hasUI || event.reason !== "quit" || reason === "error" || reason === "aborted") {
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
