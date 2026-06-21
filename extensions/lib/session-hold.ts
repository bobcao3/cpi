/**
 * Shared registry of "session hold" sources.
 *
 * A hold source wants to keep the pi process alive past an agent turn /
 * shutdown because it may yet emit a follow-up notification (e.g. a pending
 * alarm, a background shell that could still complete). Without this, alarm.ts
 * and shell.ts each registered its own `session_shutdown` hold-and-await
 * handler — but pi runs `session_shutdown` handlers SEQUENTIALLY, so two
 * independent awaits stack their deadlines and double-hold. They also each
 * ran `agent_end` hold-notice logic, double-emitting the notice and
 * double-registering the notification renderer.
 *
 * Fix: hold sources register here; a SINGLE owner extension
 * (`extensions/core.ts`) reads them at `agent_end` / `session_shutdown` time and
 * runs one await. This module is pure data + accessors — no pi imports —
 * mirroring lib/footer.ts and lib/transcript-registry.ts.
 *
 * Sharing: pi loads each extension via jiti with `moduleCache: false`, so each
 * extension gets its own module graph — module-level state here would NOT be
 * shared between importers. State is therefore backed by a single
 * `globalThis` slot, process-wide and identical across jiti loads (same
 * pattern as lib/footer.ts and lib/transcript-registry.ts).
 */

export interface HoldSource {
  id: string;
  /** True if this source still has work that may produce a follow-up turn. */
  hasPending: () => boolean;
  /** One-line human-readable summary for the hold notice. */
  noticeText: () => string;
  /** Max ms the owner should wait for this source before aborting. */
  deadlineMs: number;
  /** Best-effort cleanup invoked once by the owner after the hold ends. */
  onAbort: () => void;
}

interface HoldState {
  sources: HoldSource[];
  lastStopReason: string | undefined;
  holdNoticeSent: boolean;
  reminderDelivered: boolean;
  holdIntervalMs: number;
  holdResolve: ((value: boolean) => void) | null;
}

const GLOBAL_KEY = "__cpiHold";

function state(): HoldState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      sources: [],
      lastStopReason: undefined,
      holdNoticeSent: false,
      reminderDelivered: false,
      holdIntervalMs: 60000,
      holdResolve: null,
    } satisfies HoldState;
  }
  return g[GLOBAL_KEY] as HoldState;
}

/** Register (or replace) a hold source by id. Idempotent by id. */
export function registerHoldSource(source: HoldSource): void {
  const s = state();
  const idx = s.sources.findIndex((x) => x.id === source.id);
  if (idx === -1) {
    s.sources.push(source);
  } else {
    s.sources[idx] = source;
  }
}

/** Snapshot of all registered hold sources (callers must not mutate). */
export function getHoldSources(): HoldSource[] {
  return state().sources.slice();
}

/** Reset per-turn tracking: clears lastStopReason and holdNoticeSent. */
export function resetHoldTracking(): void {
  const s = state();
  s.lastStopReason = undefined;
  s.holdNoticeSent = false;
  s.holdIntervalMs = 60000;
}

/** Current hold interval (ms) for the agent_end backoff hold. Starts at 60s, doubles on each eventless timeout, resets to 60s on a real event or agent_start. */
export function getHoldInterval(): number {
  return state().holdIntervalMs;
}

/** Reset the backoff interval to the base 60s (called on real event / agent_start). */
export function resetHoldInterval(): void {
  state().holdIntervalMs = 60000;
}

/** Double the backoff interval (called when a hold interval elapses with no event). */
export function doubleHoldInterval(): void {
  state().holdIntervalMs *= 2;
}

export function setLastStopReason(reason: string | undefined): void {
  state().lastStopReason = reason;
}

export function getLastStopReason(): string | undefined {
  return state().lastStopReason;
}

/**
 * Consume the per-turn hold-notice flag. Returns true and sets the flag the
 * first time it is called in a turn, false thereafter — so only the first
 * caller (e.g. agent_end vs session_shutdown) emits the notice.
 */
export function consumeHoldNotice(): boolean {
  const s = state();
  if (s.holdNoticeSent) return false;
  s.holdNoticeSent = true;
  return true;
}

/**
 * Per-episode flag: has the hold reminder been delivered to the agent for the
 * current set of pending sources? Set when the owner delivers a "system
 * reminder" to a normally-stopping agent; cleared when pending reaches zero
 * (hold clears) or on shutdown. Deliberately NOT reset by resetHoldTracking
 * (which runs at every agent_start, including the reminder's follow-up turn) —
 * otherwise the agent ending normally again would re-trigger the reminder
 * forever. The flag bounds the reminder to once per episode; later normal stops
 * fall back to the deadline-bounded passive hold.
 */
export function markReminderDelivered(): void {
  state().reminderDelivered = true;
}

export function isReminderDelivered(): boolean {
  return state().reminderDelivered;
}

export function clearReminderDelivered(): void {
  state().reminderDelivered = false;
}

/**
 * Build the two-line "system reminder" body delivered to the agent when it ends
 * its turn normally (without yielding via wait_any) while hold sources are
 * pending. Line 1 lists what is being held (each source's noticeText); line 2
 * tells the agent how to resolve: wait_any to yield, or disarm/kill to return
 * control. Pure — no pi dependency; the owner does the actual delivery.
 */
export function buildHoldReminderText(pending: HoldSource[]): string {
  const parts = pending.map((s) => s.noticeText()).filter(Boolean);
  const holding = parts.length > 0 ? `Holding, ${parts.join("; ")}` : "Holding";
  return [
    `system reminder | ${holding}`,
    "system reminder | Invoke wait_any to yield and wait, or disarm / kill background shell if you want to return control back to caller.",
  ].join("\n");
}

/**
 * Resolved by a hold source (e.g. the shell completion hook in shell.ts) the
 * instant a real event fires during an active hold. The authoritative 'a
 * message was queued' signal — agent.hasQueuedMessages() — is not exposed to
 * extensions (ctx.hasPendingMessages only tracks user-queued steers, not
 * extension sends), so hold sources that aggregate multiple sub-sources (one
 * shell source for all background shells) call this on each completion to
 * resolve the hold immediately rather than waiting for the 60s timeout. No-op
 * when no hold is awaiting.
 */
export function signalHoldEvent(): void {
  const resolve = state().holdResolve;
  state().holdResolve = null;
  if (resolve) resolve(true);
}

/**
 * Wait one backoff interval for a hold source to fire.
 *
 * Polls every 100ms. Resolves `true` as soon as a source's `hasPending()`
 * drops below the initial count (a real event fired — e.g. a background shell
 * completed or an alarm fired), pending reaches zero, or `signalHoldEvent`
 * fires during the wait (a real event was signalled by a hold source). Resolves
 * `false` if the interval elapses with no event (timeout). Unlike the old
 * deadline-bounded awaitPendingHolds, this NEVER ends the session on its own —
 * a timeout is reported to the caller (core.ts), which doubles the interval
 * and nudges the agent with a reminder, keeping the session alive until the
 * agent/trial timeout.
 */
export async function awaitHoldInterval(
  sources: HoldSource[],
  intervalMs: number,
): Promise<boolean> {
  const pending = sources.filter((s) => s.hasPending());
  if (pending.length === 0) return true;
  const count = pending.length;
  const deadline = Date.now() + intervalMs;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (state().holdResolve === done) {
        state().holdResolve = null;
      }
      resolve(value);
    };
    state().holdResolve = done;
    const tick = () => {
      if (Date.now() >= deadline) return done(false);
      const nowPending = sources.filter((s) => s.hasPending()).length;
      if (nowPending < count || nowPending === 0) return done(true);
      setTimeout(tick, 100);
    };
    tick();
  });
}
