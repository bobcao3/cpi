/** Warns against repeated rapid shell polls; yield to background events instead. */

const GLOBAL_KEY = "__cpiPollGuard";
/** Allows one rapid retry after a transient error. */
const WARN_MIN_REPEAT = 2;
/** Resets repeats after 120s of inactivity. */
const STALE_RESET_S = 120;
const THROTTLE_MS = 15_000;
const MAX_HISTORY = 32;

interface CmdEntry {
  lastMs: number;
  repeat: number;
}

interface PollState {
  lastAlarmSetupMs: number | null;
  history: Map<string, CmdEntry>;
  lastWarnMs: number;
}

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

/** Called by alarm.ts when the model sets up a new alarm (not on cancel). */
export function recordAlarmSetup(): void {
  state().lastAlarmSetupMs = Date.now();
}

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
