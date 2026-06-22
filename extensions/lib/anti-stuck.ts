/**
 * Anti-stuck — a consumer of the out-of-band fork-probe (lib/fork-probe.ts).
 *
 * When the headless hold loop (core.ts) has been eventless, it periodically
 * forks the session out-of-band, asks the fork "WAIT or ABORT", and — only on
 * ABORT — appends a corrective message to the ORIGINAL session (which starts a
 * follow-up turn and exits the hold). On WAIT (or a failed/ambiguous probe) it
 * leaves the original untouched ("leave it be") and the hold continues.
 *
 * Escalation is exponential backoff of the inter-probe interval:
 *   interval_1 = threshold            (first probe after `threshold` of waiting)
 *   interval_{n+1} = min(interval_n * ratio, max_interval)   (capped backoff)
 * Defaults: threshold=30s, ratio=2, max_interval=1h — the fork is consulted
 * after 30s, then 60s later, 120s, 240s, … doubling, capping at 1h between
 * probes. {{elapsed_min}} in the prompt is the total
 * cumulative stuck time since the wait began (not the inter-probe gap).
 *
 * Configuration (env, read once at load):
 *   CPI_ANTI_STUCK_THRESHOLD_MS        first probe / base interval (default 30s)
 *   CPI_ANTI_STUCK_RATIO               backoff multiplier, >=1 (default 2)
 *   CPI_ANTI_STUCK_MAX_MS              max inter-probe interval cap (default 1h)
 *   CPI_ANTI_STUCK_PROBE_TIMEOUT_MS    fork child wall-clock bound (default 2m)
 *   CPI_FORK_PI_BIN                    pin the pi binary for the fork child
 *
 * State is process-wide on a globalThis slot (per AGENTS.md: shared *state* on
 * globalThis is sound). It is reset by any turn — core.ts calls disarmAntiStuckTimer + resetAntiStuck on agent_start (with hold reminders gone, every turn is a real event) — and by an ABORT append. Producers call only markEventlessStart / resetAntiStuck / maybeAntiStuckProbe / armAntiStuckTimer / disarmAntiStuckTimer; this module registers no handlers (core.ts owns the hold loop and arms/disarms the timer).
 *
 * Recursion: the fork child inherits the parent's extensions (including this
 * one) but cannot reach the first threshold within the probe's own wall-clock
 * bound (PROBE_TIMEOUT_MS), so it cannot re-fork. Safe by construction.
 *
 * Model-facing text (probe prompt + abort message) lives in
 * extensions/text/anti-stuck.toml (per AGENTS.md rule 4), rendered with
 * mustache: {{elapsed_min}}, {{pending}}, {{answer}}.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forkGate } from "./fork-probe.ts";
import { getHoldSources, signalHoldEvent, type HoldSource } from "./session-hold.ts";
import { loadText, render, textPath } from "./text.ts";

// ── Constants (explicit limits, env-configurable) ──────────────────────────

function envMs(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function envRatio(key: string, fallback: number): number {
  const n = Number(process.env[key] ?? String(fallback));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

/** First probe time / base inter-probe interval (default 30s). */
const THRESHOLD_MS = envMs("CPI_ANTI_STUCK_THRESHOLD_MS", 30 * 1000);
/** Backoff multiplier between successive inter-probe intervals, >=1 (default 2). */
const RATIO = envRatio("CPI_ANTI_STUCK_RATIO", 2);
/** Cap on the inter-probe interval; the backoff plateaus here (default 1h). */
const MAX_INTERVAL_MS = envMs("CPI_ANTI_STUCK_MAX_MS", 60 * 60 * 1000);
/** Wall-clock bound for the fork child. */
const PROBE_TIMEOUT_MS = envMs("CPI_ANTI_STUCK_PROBE_TIMEOUT_MS", 2 * 60 * 1000);
const PROBE_AUDIT_TYPE = "anti-stuck-probe"; // transcript-only audit (CustomEntry, excluded from LLM context)
const REMINDER_TYPE = "system-reminder"; // the abort corrective message, framed as a system reminder the agent sees (never 'anti-stuck')

const cap = (ms: number): number => Math.min(ms, MAX_INTERVAL_MS);

// ── Text ───────────────────────────────────────────────────────────────────

interface AntiStuckText {
  probe: { prompt: string };
  append: { abort: string };
}

// ── State (globalThis, see header) ──────────────────────────────────────────

const GLOBAL_KEY = "__cpiAntiStuck";

interface AntiStuckState {
  /** Wall-clock ms when the eventless wait began (null = not waiting). */
  waitSinceMs: number | null;
  /** Wall-clock ms when the next probe is due (null = not armed). */
  nextProbeAtMs: number | null;
  /** Current inter-probe interval, grown by RATIO and capped at MAX_INTERVAL_MS. */
  intervalMs: number;
  /** Self-rescheduling setTimeout handle (used in both TUI and headless). */
  timer: NodeJS.Timeout | null;
}

function state(): AntiStuckState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { waitSinceMs: null, nextProbeAtMs: null, intervalMs: cap(THRESHOLD_MS), timer: null } satisfies AntiStuckState;
  }
  return g[GLOBAL_KEY] as AntiStuckState;
}

/** Mark the start of the eventless wait. Idempotent — only the first call per
 *  episode arms the schedule. Called by core.ts when a hold with pending sources begins. */
export function markEventlessStart(): void {
  const s = state();
  if (s.waitSinceMs !== null) return;
  s.waitSinceMs = Date.now();
  s.intervalMs = cap(THRESHOLD_MS);
  s.nextProbeAtMs = s.waitSinceMs + s.intervalMs;
}

/** Reset on a REAL hold event (fired) or an ABORT append — the episode ended. */
export function resetAntiStuck(): void {
  const s = state();
  s.waitSinceMs = null;
  s.nextProbeAtMs = null;
  s.intervalMs = cap(THRESHOLD_MS);
}

function alarmUpcoming(): boolean {
  return getHoldSources().some((src) => src.id === "alarm" && src.hasPending());
}

// ── The probe ──────────────────────────────────────────────────────────────

export type AntiStuckResult = "not_applicable" | "probed_wait" | "probed_abort";

/**
 * Maybe run an anti-stuck fork probe. Returns:
 *   "not_applicable" — no persisted session, wait not armed, not due yet, or an
 *                      alarm (deterministic wakeup) is upcoming; caller delivers a reminder.
 *   "probed_wait"    — fork ran and did NOT abort (WAIT / ambiguous / failed);
 *                      original left untouched; the backoff advances and caller
 *                      delivers a reminder to keep the hold alive.
 *   "probed_abort"   — fork answered ABORT; a corrective message was appended
 *                      to the original and a follow-up turn was triggered;
 *                      caller must NOT deliver a reminder (the turn takes over).
 */
export async function maybeAntiStuckProbe(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pending: HoldSource[],
): Promise<AntiStuckResult> {
  const parentFile = ctx.sessionManager?.getSessionFile();
  if (!parentFile) return "not_applicable";
  const s = state();
  if (s.waitSinceMs === null || s.nextProbeAtMs === null) return "not_applicable";
  if (Date.now() < s.nextProbeAtMs) return "not_applicable"; // not due yet
  if (alarmUpcoming()) return "not_applicable"; // a deterministic wakeup will end the wait

  const elapsed = Date.now() - s.waitSinceMs;
  const T = loadText<AntiStuckText>("anti-stuck", textPath("anti-stuck"));
  const elapsedMin = Math.round(elapsed / 60000);
  const pendingText = pending.map((src) => src.noticeText()).filter(Boolean).join("; ") || "(none)";
  const prompt = render(T.probe?.prompt ?? "", { elapsed_min: elapsedMin, pending: pendingText });

  const outcome = await forkGate({
    command: process.env.CPI_FORK_PI_BIN,
    parentSessionFile: parentFile,
    cwd: ctx.cwd,
    signal: ctx.signal,
    timeoutMs: PROBE_TIMEOUT_MS,
    prompt,
    decide: (answer) => (answer.trim().toUpperCase().includes("ABORT") ? "ABORT" : null),
    onSignal: (_signal, answer) => {
      const text = render(T.append?.abort ?? "", { answer, elapsed_min: elapsedMin, pending: pendingText });
      try {
        pi.sendMessage(
          { customType: REMINDER_TYPE, content: `system reminder | ${text}`, display: true },
          { triggerTurn: true, deliverAs: "steer" },
        );
      } catch {
        // Delivery failure must never break the hold flow.
      }
    },
  });

  const verdict = outcome.appended ? "ABORT" : outcome.ok ? "WAIT" : "FAILED";
  // Transcript-only audit (CustomEntry, excluded from LLM context) so /tree
  // records every probe (incl. WAIT/failed) without the agent seeing it.
  try {
    pi.appendEntry(PROBE_AUDIT_TYPE, { verdict, elapsed_min: elapsedMin, pending: pendingText, answer: outcome.answer.slice(0, 2000), at: new Date().toISOString() });
  } catch { /* audit is best-effort */ }

  if (outcome.appended) {
    resetAntiStuck(); // abort ends the episode; the follow-up turn resets via its own agent_end
    // Release the headless keep-alive loop so the appended follow-up turn can run
    // (no-op in TUI, where there is no hold await).
    signalHoldEvent();
    return "probed_abort";
  }
  // WAIT / ambiguous / failed: leave the original untouched and back off.
  s.intervalMs = cap(s.intervalMs * RATIO);
  s.nextProbeAtMs = Date.now() + s.intervalMs;
  return "probed_wait";
}

// ── TUI timer path ─────────────────────────────────────────────────────────
//
// In headless mode the hold loop's await is the clock — core.ts calls
// maybeAntiStuckProbe on each eventless timeout, so no separate timer is
// needed. In TUI mode there is no hold await (the process stays alive on its
// own), so anti-stuck is driven by a self-rescheduling setTimeout. The timer
// is armed at agent_end when a potentially-stuck wait begins and disarmed by
// any turn (agent_start) or session switch (session_start).

function clearTimer(s: AntiStuckState): void {
  if (s.timer) {
    clearTimeout(s.timer);
  }
  s.timer = null;
}

/** Disarm the self-rescheduling TUI timer. Called on agent_start / session_start. */
export function disarmAntiStuckTimer(): void {
  clearTimer(state());
}

/** Arm (or re-arm) the self-rescheduling TUI timer. Called at agent_end. */
export function armAntiStuckTimer(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const s = state();
  clearTimer(s);
  if (s.waitSinceMs === null || s.nextProbeAtMs === null) return;
  let delay = s.nextProbeAtMs - Date.now();
  if (delay <= 0) delay = s.intervalMs; // one interval out — avoid busy-loop after an alarm-skip
  s.timer = setTimeout(() => void tickAntiStuck(pi, ctx), delay);
}

/** Timer expiry: run one probe, then re-arm (unless the wait ended or aborted). */
async function tickAntiStuck(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  const s = state();
  s.timer = null;
  if (s.waitSinceMs === null) return; // wait ended
  const freshPending = getHoldSources().filter((src) => src.hasPending());
  const probeCtx = { sessionManager: ctx.sessionManager, cwd: ctx.cwd, signal: undefined } as any;
  // Show a TUI widget while the fork runs; widgets are TUI-only and never
  // reach the agent's context.
  if (ctx?.hasUI) ctx.ui.setWidget("anti-stuck", ["⏳ Running stuck-check..."]);
  try {
    const result = await maybeAntiStuckProbe(pi, probeCtx, freshPending);
    if (result === "probed_abort") return; // the appended turn disarms via agent_start
    if (state().waitSinceMs === null) return; // reset meanwhile
    armAntiStuckTimer(pi, ctx); // probed_wait already advanced nextProbeAtMs
  } finally {
    if (ctx?.hasUI) ctx.ui.setWidget("anti-stuck", undefined);
  }
}
