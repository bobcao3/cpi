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
 * Await pending hold sources. Called from the headless agent_end owner.
 *
 * While this awaits, `isStreaming` stays true (AgentState contract: remains
 * true until agent_end listeners settle), so a source firing via
 * sendNotification queues a steer/followUp rather than starting a concurrent
 * prompt. On resolve, the run loop's `hasQueuedMessages` sees the queued
 * message and `continue()` drives the follow-up turn — passive waiting
 * without polling.
 *
 * Resolves when: the deadline (max of all source deadlines) is reached, OR a
 * source fires (pending count drops below the initial snapshot), OR pending
 * reaches zero.
 */
export async function awaitPendingHolds(sources: HoldSource[]): Promise<void> {
  const pending = sources.filter((s) => s.hasPending());
  if (pending.length === 0) return;
  const deadline = Date.now() + Math.max(...pending.map((s) => s.deadlineMs));
  const count = pending.length;
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (Date.now() >= deadline) return resolve();
      const nowPending = sources.filter((s) => s.hasPending()).length;
      if (nowPending < count || nowPending === 0) return resolve();
      setTimeout(tick, 100);
    };
    tick();
  });
}
