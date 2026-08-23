/** Anti-stuck: consumer of the out-of-band fork-probe. When the headless hold loop is eventless, fork and ask "WAIT or ABORT"; only ABORT appends a corrective message to the ORIGINAL session (follow-up turn exits the hold). Inter-probe interval backs off 30s ×2 cap 1h (CPI_ANTI_STUCK_*); the fork child cannot re-fork within PROBE_TIMEOUT_MS. */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { forkGate, type ForkGateOutcome } from "./fork-probe.ts";
import {
  getHoldSources,
  signalHoldEvent,
  type HoldSource,
} from "./session-hold.ts";
import { goalStuckResume, isGoalActive } from "./goal.ts";
import { loadText, render, textPath } from "./text.ts";

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

const THRESHOLD_MS = envMs("CPI_ANTI_STUCK_THRESHOLD_MS", 30 * 1000);
const RATIO = envRatio("CPI_ANTI_STUCK_RATIO", 2);
const MAX_INTERVAL_MS = envMs("CPI_ANTI_STUCK_MAX_MS", 60 * 60 * 1000);
const PROBE_TIMEOUT_MS = envMs(
  "CPI_ANTI_STUCK_PROBE_TIMEOUT_MS",
  2 * 60 * 1000,
);
const PROBE_AUDIT_TYPE = "anti-stuck-probe";
const REMINDER_TYPE = "system-reminder"; // framed as a system reminder the agent sees, never 'anti-stuck'

const cap = (ms: number): number => Math.min(ms, MAX_INTERVAL_MS);

interface AntiStuckText {
  probe: { prompt: string };
  append: { abort: string };
}

const GLOBAL_KEY = "__cpiAntiStuck";

interface AntiStuckState {
  waitSinceMs: number | null;
  nextProbeAtMs: number | null;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  probeController: AbortController | null;
}

function state(): AntiStuckState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      waitSinceMs: null,
      nextProbeAtMs: null,
      intervalMs: cap(THRESHOLD_MS),
      timer: null,
      probeController: null,
    } satisfies AntiStuckState;
  }
  const current = g[GLOBAL_KEY] as AntiStuckState;
  // Migrate process-wide state created by an older hot-loaded module copy.
  if (current.probeController === undefined) current.probeController = null;
  return current;
}

function cancelProbe(s: AntiStuckState): void {
  s.probeController?.abort();
  s.probeController = null;
}

/** Idempotent: only the first call per episode arms the schedule. */
export function markEventlessStart(): void {
  const s = state();
  if (s.waitSinceMs !== null) return;
  s.waitSinceMs = Date.now();
  s.intervalMs = cap(THRESHOLD_MS);
  s.nextProbeAtMs = s.waitSinceMs + s.intervalMs;
}

export function resetAntiStuck(): void {
  const s = state();
  cancelProbe(s);
  s.waitSinceMs = null;
  s.nextProbeAtMs = null;
  s.intervalMs = cap(THRESHOLD_MS);
}

function alarmUpcoming(): boolean {
  return getHoldSources().some((src) => src.id === "alarm" && src.hasPending());
}

export type AntiStuckResult = "not_applicable" | "probed_wait" | "probed_abort";

/** Maybe run an anti-stuck fork probe: "not_applicable" (no session, not due, or alarm upcoming — caller delivers a reminder), "probed_wait" (no ABORT — original untouched, backoff advances), "probed_abort" (ABORT or goal resume — follow-up turn triggered; caller must NOT deliver a reminder). */
export async function maybeAntiStuckProbe(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pending: HoldSource[],
): Promise<AntiStuckResult> {
  const parentFile = ctx.sessionManager?.getSessionFile();
  if (!parentFile) return "not_applicable";
  const s = state();
  if (s.waitSinceMs === null || s.nextProbeAtMs === null)
    return "not_applicable";
  if (Date.now() < s.nextProbeAtMs) return "not_applicable";
  if (alarmUpcoming()) return "not_applicable";

  const elapsed = Date.now() - s.waitSinceMs;
  const T = loadText<AntiStuckText>("anti-stuck", textPath("anti-stuck"));
  const elapsedMin = Math.round(elapsed / 60000);
  const pendingText =
    pending
      .map((src) => src.noticeText())
      .filter(Boolean)
      .join("; ") || "(none)";

  // Goal active: resume the agent directly instead of the fork (mirrors the ABORT path; sendMessage is fire-and-forget).
  if (isGoalActive()) {
    goalStuckResume(pi, elapsedMin, pendingText);
    resetAntiStuck();
    signalHoldEvent();
    return "probed_abort";
  }

  const prompt = render(T.probe?.prompt ?? "", {
    elapsed_min: elapsedMin,
    pending: pendingText,
  });
  if (s.probeController) return "not_applicable"; // one check per wait episode
  const probeController = new AbortController();
  s.probeController = probeController;
  const abortFromContext = (): void => probeController.abort();
  if (ctx.signal?.aborted) abortFromContext();
  else ctx.signal?.addEventListener("abort", abortFromContext, { once: true });

  let outcome: ForkGateOutcome<"ABORT">;
  try {
    outcome = await forkGate<"ABORT">({
      parentSessionFile: parentFile,
      cwd: ctx.cwd,
      signal: probeController.signal,
      timeoutMs: PROBE_TIMEOUT_MS,
      prompt,
      // A child may exit while its cancellation races SIGTERM — never let a stale answer wake the now-active session.
      decide: (answer) => {
        if (probeController.signal.aborted) return null;
        return answer.trim().toUpperCase().includes("ABORT") ? "ABORT" : null;
      },
      onSignal: (_signal, answer) => {
        const text = render(T.append?.abort ?? "", {
          answer,
          elapsed_min: elapsedMin,
          pending: pendingText,
        });
        try {
          pi.sendMessage(
            {
              customType: REMINDER_TYPE,
              content: `system reminder | ${text}`,
              display: true,
            },
            { triggerTurn: true, deliverAs: "steer" },
          );
        } catch {
          // Delivery failure must never break the hold flow.
        }
      },
    });
  } finally {
    ctx.signal?.removeEventListener("abort", abortFromContext);
    if (s.probeController === probeController) s.probeController = null;
  }
  if (probeController.signal.aborted) return "not_applicable";

  const verdict = outcome.appended ? "ABORT" : outcome.ok ? "WAIT" : "FAILED";
  try {
    pi.appendEntry(PROBE_AUDIT_TYPE, {
      verdict,
      elapsed_min: elapsedMin,
      pending: pendingText,
      answer: outcome.answer.slice(0, 2000),
      at: new Date().toISOString(),
    });
  } catch {
    /* audit is best-effort */
  }

  if (outcome.appended) {
    resetAntiStuck();
    // Release the headless keep-alive loop so the appended follow-up turn can run (no-op in TUI).
    signalHoldEvent();
    return "probed_abort";
  }
  s.intervalMs = cap(s.intervalMs * RATIO);
  s.nextProbeAtMs = Date.now() + s.intervalMs;
  return "probed_wait";
}

// Headless: the hold loop's await is the clock (core.ts probes per eventless timeout). TUI: no hold await — a self-rescheduling setTimeout drives probes.

function clearTimer(s: AntiStuckState): void {
  if (s.timer) {
    clearTimeout(s.timer);
  }
  s.timer = null;
}

export function disarmAntiStuckTimer(): void {
  const s = state();
  clearTimer(s);
  cancelProbe(s);
}

export function armAntiStuckTimer(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): void {
  const s = state();
  clearTimer(s);
  if (s.waitSinceMs === null || s.nextProbeAtMs === null) return;
  let delay = s.nextProbeAtMs - Date.now();
  if (delay <= 0) delay = s.intervalMs; // one interval out — avoid busy-loop after an alarm-skip
  s.timer = setTimeout(() => void tickAntiStuck(pi, ctx), delay);
}

async function tickAntiStuck(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  const s = state();
  s.timer = null;
  if (s.waitSinceMs === null) return;
  const freshPending = getHoldSources().filter((src) => src.hasPending());
  const probeCtx = {
    sessionManager: ctx.sessionManager,
    cwd: ctx.cwd,
    signal: undefined,
  } as any;
  if (ctx?.hasUI) ctx.ui.setWidget("anti-stuck", ["⏳ Running stuck-check..."]);
  try {
    const result = await maybeAntiStuckProbe(pi, probeCtx, freshPending);
    if (result === "probed_abort") return;
    if (state().waitSinceMs === null) return;
    armAntiStuckTimer(pi, ctx); // probed_wait already advanced nextProbeAtMs
  } finally {
    if (ctx?.hasUI) ctx.ui.setWidget("anti-stuck", undefined);
  }
}
