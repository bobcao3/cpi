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
 * (extensions/hold.ts) reads them at `agent_end` / `session_shutdown` time and
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
}

const GLOBAL_KEY = "__cpiHold";

function state(): HoldState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      sources: [],
      lastStopReason: undefined,
      holdNoticeSent: false,
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
