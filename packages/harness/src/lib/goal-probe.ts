import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  achieveGoal,
  budgetPauseGoal,
  continueGoal,
  evaluateGoal,
  getGoalRevision,
  isGoalActive,
} from "./goal.ts";
import { getLastOutcome, registerHoldSource } from "./session-hold.ts";
import { loadText, textPath } from "./text.ts";

export function registerGoalProbe(pi: ExtensionAPI, scope: object) {
  const text = loadText<{ evaluate: { waiting: string } }>(
    "goal",
    textPath("goal"),
  );
  let controller: AbortController | undefined;
  let clearWidget: (() => void) | undefined;
  const cancel = () => {
    controller?.abort();
    controller = undefined;
    clearWidget?.();
    clearWidget = undefined;
  };
  const unregister = registerHoldSource({
    id: "goal-probe",
    scope,
    passive: true,
    hasPending: () => controller !== undefined,
    noticeText: () => text.evaluate.waiting,
    deadlineMs: 5 * 60 * 1000,
    onAbort: () => {
      cancel();
      unregister();
    },
  });
  pi.on("agent_start", cancel);
  pi.on("agent_settled", (event) => {
    if (event.aborted) cancel();
  });
  pi.on("session_start", cancel);
  pi.on("session_tree", cancel);
  pi.on("session_shutdown", (event, ctx) => {
    const outcome = getLastOutcome();
    if (ctx.hasUI || event.reason !== "quit" || outcome !== "completed") {
      cancel();
      unregister();
    }
  });
  return (ctx: ExtensionContext): void => {
    cancel();
    const active = new AbortController();
    controller = active;
    const revision = getGoalRevision();
    const current = () =>
      controller === active &&
      !active.signal.aborted &&
      isGoalActive() &&
      getGoalRevision() === revision;
    if (ctx.hasUI) {
      ctx.ui.setWidget("goal-eval", ["🎯 Evaluating goal…"]);
      clearWidget = () => ctx.ui.setWidget("goal-eval", undefined);
    }
    const parentSignal = ctx.signal;
    const signal = parentSignal
      ? AbortSignal.any([parentSignal, active.signal])
      : active.signal;
    void evaluateGoal(pi, ctx, signal, current)
      .then((verdict) => {
        if (signal.aborted || !current()) return;
        if (verdict.status === "met") achieveGoal(pi, ctx);
        else if (verdict.status === "failed")
          budgetPauseGoal(pi, ctx, verdict.reason);
        else continueGoal(pi, ctx, verdict.reason);
      })
      .catch((error) => {
        if (current()) budgetPauseGoal(pi, ctx, String(error));
      })
      .finally(() => {
        if (controller === active) cancel();
      });
  };
}
