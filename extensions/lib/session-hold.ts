/** Single-owner invariant: core.ts performs one await; pi runs session_shutdown handlers sequentially. */

export interface HoldSource {
  id: string;
  hasPending: () => boolean;
  noticeText: () => string;
  deadlineMs: number;
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

export function registerHoldSource(source: HoldSource): void {
  const s = state();
  const idx = s.sources.findIndex((x) => x.id === source.id);
  if (idx === -1) {
    s.sources.push(source);
  } else {
    s.sources[idx] = source;
  }
}

export function getHoldSources(): HoldSource[] {
  return state().sources.slice();
}

export function resetHoldTracking(): void {
  const s = state();
  s.lastStopReason = undefined;
  s.holdNoticeSent = false;
  s.holdIntervalMs = 60000;
}

export function getHoldInterval(): number {
  return state().holdIntervalMs;
}

export function resetHoldInterval(): void {
  state().holdIntervalMs = 60000;
}

export function doubleHoldInterval(): void {
  state().holdIntervalMs *= 2;
}

export function setLastStopReason(reason: string | undefined): void {
  state().lastStopReason = reason;
}

export function getLastStopReason(): string | undefined {
  return state().lastStopReason;
}

/** First caller per turn emits the notice. */
export function consumeHoldNotice(): boolean {
  const s = state();
  if (s.holdNoticeSent) return false;
  s.holdNoticeSent = true;
  return true;
}

/** resetHoldTracking must not clear reminderDelivered. */
export function markReminderDelivered(): void {
  state().reminderDelivered = true;
}

export function isReminderDelivered(): boolean {
  return state().reminderDelivered;
}

export function clearReminderDelivered(): void {
  state().reminderDelivered = false;
}

export function buildHoldReminderText(pending: HoldSource[]): string {
  const parts = pending.map((s) => s.noticeText()).filter(Boolean);
  const holding = parts.length > 0 ? `Holding, ${parts.join("; ")}` : "Holding";
  return [
    `system reminder | ${holding}`,
    "system reminder | Invoke wait_any to yield and wait, or disarm / kill background shell if you want to return control back to caller.",
  ].join("\n");
}

/** Resolves sends because hasPending() cannot observe extension sends. */
export function signalHoldEvent(): void {
  const resolve = state().holdResolve;
  state().holdResolve = null;
  if (resolve) resolve(true);
}

/** True means a real event; false means timeout—the caller doubles the interval and nudges. */
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
