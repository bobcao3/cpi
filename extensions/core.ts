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
import { drainAfterTool, drainBeforeUser } from "./lib/prepend-message.ts";
import { registerNotificationRenderer } from "./lib/notification.ts";
import { setupCpiFooter, disposeCpiFooter, registerRightSegment } from "./lib/footer.ts";
import { getSubagentUsage, resetSubagentUsage } from "./lib/cost-ledger.ts";
import {
  awaitHoldInterval,
  buildHoldReminderText,
  clearReminderDelivered,
  consumeHoldNotice,
  doubleHoldInterval,
  getHoldInterval,
  getHoldSources,
  getLastStopReason,
  isReminderDelivered,
  markReminderDelivered,
  resetHoldInterval,
  resetHoldTracking,
  setLastStopReason,
  type HoldSource,
} from "./lib/session-hold.ts";

export default function coreExtension(pi: ExtensionAPI): void {
  // ── Footer owner ────────────────────────────────────────────────────────
  // Owns pi's custom footer for all cpi extensions. Contributors (vcs-jj,
  // caveman-micro, shell/status) push data via lib/footer.ts; they never
  // call setFooter. Re-setup on session_start/tree is idempotent.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    setupCpiFooter(pi, ctx);
    resetSubagentUsage();
    registerRightSegment("subagent-cost", costSegment);
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
        buildCpiSystemPrompt(event.systemPromptOptions),
        ctx,
        event.systemPromptOptions,
      ),
    };
  });

  // ── Session-hold owner ─────────────────────────────────────────────────
  // The SINGLE extension that owns hold logic: one combined hold notice +
  // one deadline await across all hold sources (alarm, shell). Sources only
  // `registerHoldSource` + own their `onAbort` cleanup; they never run hold
  // awaits or emit notices themselves.
  pi.on("agent_start", () => resetHoldTracking());

  pi.on("agent_end", async (event: any, ctx: any) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m.role === "assistant") {
        setLastStopReason(m.stopReason);
        break;
      }
    }
    if (ctx.hasUI) return;
    const reason = getLastStopReason();
    if (reason === "error" || reason === "aborted") return;
    const sources = getHoldSources();
    const pending = sources.filter((s) => s.hasPending());
    if (pending.length === 0) {
      clearReminderDelivered();
      return;
    }
    // When the agent stops without explicitly yielding via wait_any while hold
    // sources are pending, surface the hold to the agent as a "system reminder"
    // (headless-only) so it can decide — wait_any to yield, or sh_signal SIGKILL
    // to return control. Delivered once per hold episode (reminderDelivered flag,
    // cleared when pending hits zero) so a normally-stopping agent is not nagged
    // into a reminder loop; the reminder's follow-up turn keeps the session alive,
    // so no await here. The wait_any / already-reminded paths fall back to the
    // deadline-bounded passive hold.
    if (!endedViaWaitAny(event.messages) && !isReminderDelivered()) {
      markReminderDelivered();
      deliverHoldReminder(pi, pending);
      return;
    }
    if (consumeHoldNotice()) emitHoldNotice(ctx, pending);
    // Hold the run open until pending alarms/background shells fire. While we await,
    // isStreaming stays true, so their sendNotification queues a steer/followUp that
    // the run loop's hasQueuedMessages->continue turns into a follow-up turn —
    // passive waiting without polling. Headless-only: TUI stays alive on its own.
    const interval = getHoldInterval();
    const fired = await awaitHoldInterval(sources, interval);
    if (fired) {
      resetHoldInterval();
    } else {
      doubleHoldInterval();
      markReminderDelivered();
      deliverHoldTimeoutReminder(pi, pending, interval, getHoldInterval());
    }
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    const reason = getLastStopReason();
    const sources = getHoldSources();
    const abortAll = () => {
      clearReminderDelivered();
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
    if (consumeHoldNotice()) emitHoldNotice(ctx, pending);
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

function emitHoldNotice(ctx: any, pending: HoldSource[]): void {
  const text = pending
    .map((s) => s.noticeText())
    .filter(Boolean)
    .join(" ; ");
  try {
    process.stderr.write(`[hold] ${text}\n`);
  } catch {
    // stderr writes must never break the hold flow.
  }
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}

function costSegment(): string | undefined {
  const u = getSubagentUsage();
  if (u.count === 0) return undefined;
  return `sub $${u.cost.toFixed(4)}·${u.count}`;
}

const WAIT_ANY_TOOL = "wait_any";
const HOLD_REMINDER_TYPE = "hold-reminder";

// Detects whether the agent explicitly yielded via wait_any (so we skip the
// reminder) vs ended its turn normally. wait_any returns terminate:true, so
// it is always the last tool of a turn when used; scanning from the end for
// the most recent toolResult and checking its toolName is sufficient.
function endedViaWaitAny(messages: any[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "toolResult") {
      return m.toolName === WAIT_ANY_TOOL;
    }
  }
  return false;
}

// Delivered during agent_end while isStreaming is still true (so deliverAs is
// honored). Use "steer" (not "followUp") because steer is drained by the agent
// loop into the imminent wake turn's context before its LLM call, so the
// reminder is visible to the turn that wakes the agent; followUp is drained
// only after tool calls/steer clear, which races the wake turn. triggerTurn:
// true covers the idle non-streaming fallback via _runAgentPrompt. No await:
// the queued steer is itself the effect the run loop's hasQueuedMessages->
// continue exits the hold on; the follow-up turn holds the session open.
function deliverHoldReminder(pi: ExtensionAPI, pending: HoldSource[]): void {
  const text = buildHoldReminderText(pending);
  try {
    pi.sendMessage(
      { customType: HOLD_REMINDER_TYPE, content: text, display: true },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // Delivery failure must never break the hold flow.
  }
}

// Fires on each eventless hold timeout (wait_any path) and carries the backoff
// state. deliverAs:"steer" (not "followUp") is load-bearing: steer is drained
// by the agent loop into the imminent wake turn before its LLM call, so the
// "Held for Ns" text reaches the turn that wakes the agent. followUp is
// drained only after tool calls/steer clear, which races the wake turn —
// observed in tb21-cpi-kimi-c8 where the reminder landed one turn late and
// the agent concluded wait_any "returned immediately" (it instead saw
// wait_any's own "(see attached image)" mistranslation from pi-ai
// convertMessages). The queued steer is the effect the run loop's
// hasQueuedMessages->continue exits the hold on.
function deliverHoldTimeoutReminder(
  pi: ExtensionAPI,
  pending: HoldSource[],
  elapsedMs: number,
  nextMs: number,
): void {
  const status = pending
    .map((s) => s.noticeText())
    .filter(Boolean)
    .join("; ");
  const elapsedSec = Math.round(elapsedMs / 1000);
  const nextSec = Math.round(nextMs / 1000);
  const text = [
    `system reminder | ${status}`,
    `system reminder | Held for ${elapsedSec}s without events, you can continue hold for up-to another ${nextSec}s, or check the status of the job.`,
  ].join("\n");
  try {
    pi.sendMessage(
      { customType: HOLD_REMINDER_TYPE, content: text, display: true },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {
    // Delivery failure must never break the hold flow.
  }
}
