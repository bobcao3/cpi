/**
 * Poll-guard: detects busy-wait / idle-poll behavior.
 *
 * Some models, instead of relinquishing control and waiting for a background
 * event (a shell-completion notification or an alarm firing), re-run the same
 * shell command in a tight alarm→check loop. This module measures the gap from
 * the most recent poll-cycle anchor — the last alarm setup if one was committed
 * since the prior run of this command, else that prior run — to the current
 * invocation, and emits a slow-down advisory when that gap is smaller than an
 * exponentially growing backoff threshold (2^(n_repeat+1) seconds).
 *
 * State is process-wide shared mutable data on a `globalThis` slot (per
 * AGENTS.md: shared *state* on globalThis is sound; only boolean dedup *flags*
 * gating per-instance registration are the anti-pattern). Reloads re-read it.
 * Producers (shell.ts, alarm.ts) call only `checkShellPoll` / `recordAlarmSetup`;
 * they register no renderers or handlers.
 */

// ── Constants (explicit limits, per TigerStyle) ─────────────────────────────

const GLOBAL_KEY = "__cpiPollGuard";
/** Minimum consecutive repeats before warning; tolerates a single rapid retry
 *  (e.g. `!!` after a transient error) without nagging. */
const WARN_MIN_REPEAT = 2;
/** Gap (seconds) after which a command is considered abandoned and its repeat
 *  counter resets — i.e. a fresh poll session. */
const STALE_RESET_S = 120;
/** Minimum milliseconds between emitted warnings (global throttle). */
const THROTTLE_MS = 15_000;
/** Bound on tracked distinct commands; oldest evicted when exceeded. */
const MAX_HISTORY = 32;

// ── Types ───────────────────────────────────────────────────────────────────

interface CmdEntry {
  lastMs: number;
  repeat: number;
}

interface PollState {
  lastAlarmSetupMs: number | null;
  history: Map<string, CmdEntry>;
  lastWarnMs: number;
}

// ── Process-wide shared state (globalThis, see header) ──────────────────────

function state(): PollState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      lastAlarmSetupMs: null,
      history: new Map<string, CmdEntry>(),
      lastWarnMs: 0,
    } satisfies PollState;
  }
  return g[GLOBAL_KEY] as PollState;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Collapse runs of whitespace so trivially-differing repeats still match. */
function normalize(cmd: string): string {
  return cmd.trim().replace(/\s+/g, " ");
}

function evictOldest(history: Map<string, CmdEntry>): void {
  if (history.size <= MAX_HISTORY) return;
  let oldestKey: string | null = null;
  let oldestMs = Infinity;
  for (const [key, entry] of history) {
    if (entry.lastMs < oldestMs) {
      oldestMs = entry.lastMs;
      oldestKey = key;
    }
  }
  if (oldestKey) history.delete(oldestKey);
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Called by alarm.ts when the model sets up a new alarm (not on cancel). */
export function recordAlarmSetup(): void {
  state().lastAlarmSetupMs = Date.now();
}

/**
 * Called by shell.ts after `!!` resolution, once the command is confirmed to
 * run (past lint/rule rejection). Returns a slow-down advisory string when
 * repeated identical invocations arrive faster than the exponential backoff
 * threshold (2^(n_repeat+1) seconds); otherwise null. Pure with respect to pi:
 * mutates only shared poll-guard state, touches no pi API.
 *
 * The measured interval is from the most recent poll-cycle anchor — the last
 * alarm setup if one is newer than the prior run of this command, else that
 * prior run — to the current invocation. This captures both the alarm→shell
 * "set an alarm but didn't wait for it" case and bare rapid re-runs.
 */
export function checkShellPoll(command: string): string | null {
  const s = state();
  const now = Date.now();
  const cmd = normalize(command);
  const entry = s.history.get(cmd);

  if (!entry) {
    s.history.set(cmd, { lastMs: now, repeat: 0 });
    evictOldest(s.history);
    return null;
  }

  const sinceAlarm = (s.lastAlarmSetupMs ?? 0) > entry.lastMs;
  const anchor = Math.max(entry.lastMs, s.lastAlarmSetupMs ?? 0);
  const intervalS = (now - anchor) / 1000;

  // Abandoned long enough → treat as a fresh poll session.
  if (intervalS > STALE_RESET_S) {
    s.history.set(cmd, { lastMs: now, repeat: 0 });
    return null;
  }

  const newRepeat = entry.repeat + 1;
  const thresholdS = 2 ** (newRepeat + 1);
  s.history.set(cmd, { lastMs: now, repeat: newRepeat });

  if (!(intervalS < thresholdS) || newRepeat < WARN_MIN_REPEAT) return null;
  if (now - s.lastWarnMs < THROTTLE_MS) return null;
  s.lastWarnMs = now;

  const origin = sinceAlarm ? "since alarm setup" : "since last run";
  return [
    "⚠ slow-down: busy-wait / idle-poll detected",
    `Command \`${cmd}\` repeated ${newRepeat} times; last gap ${intervalS.toFixed(1)}s (${origin}) < backoff 2^${newRepeat + 1} = ${thresholdS}s.`,
    "Relinquish control — stop re-checking and wait for the background event (a shell-completion notification or an alarm firing) instead of polling.",
    "For sanctioned polling use sh_repeat_until; for a simple delayed wake-up use alarm and then yield.",
  ].join("\n");
}
