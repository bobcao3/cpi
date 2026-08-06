/**
 * Shared cpi footer. cpi keeps pi's standard footer intact and publishes
 * custom contributors through its status row instead of splicing into the
 * built-in render. State is globalThis-backed: jiti loads each extension
 * with moduleCache:false, so module-level state would not be shared between
 * importers.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const REFRESH_MS = 2000;
const GLOBAL_KEY = "__cpiFooter";

type Maybe<T> = T | null | undefined;
type Producer = () => Maybe<string>;

interface Contributor {
  name?: string;
  produce: Producer;
  refresh?: () => void;
}

interface FooterState {
  branchResolver: Contributor | null;
  segments: Contributor[];
  rightSegments: Contributor[];
  setStatus: ExtensionContext["ui"]["setStatus"] | undefined;
  activeStatusKeys: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
}

function state(): FooterState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      branchResolver: null,
      segments: [],
      rightSegments: [],
      setStatus: undefined,
      activeStatusKeys: new Set(),
      timer: null,
    } satisfies FooterState;
  } else {
    const s = g[GLOBAL_KEY] as FooterState;
    s.activeStatusKeys ??= new Set();
    s.setStatus ??= undefined;
  }
  return g[GLOBAL_KEY] as FooterState;
}

// Poll only when a contributor needs it; the built-in git watcher covers pure-git repos.

function statusKey(kind: string, name: string): string {
  return `cpi-footer:${kind}:${name}`;
}

function hasRefreshContributor(): boolean {
  const s = state();
  return Boolean(
    s.branchResolver?.refresh ||
    s.segments.some((seg) => seg.refresh) ||
    s.rightSegments.some((seg) => seg.refresh),
  );
}

function syncStatuses(): void {
  const s = state();
  if (!s.setStatus) return;
  const current = new Map<string, string>();
  const branch = s.branchResolver?.produce();
  if (branch) current.set("cpi-footer:branch", branch);
  for (const seg of s.segments) {
    const value = seg.produce();
    if (value) current.set(statusKey("line", seg.name), value);
  }
  for (const seg of s.rightSegments) {
    const value = seg.produce();
    if (value) current.set(statusKey("right", seg.name), value);
  }
  for (const key of s.activeStatusKeys) {
    if (!current.has(key)) s.setStatus(key, undefined);
  }
  for (const [key, value] of current) {
    s.setStatus(key, value);
  }
  s.activeStatusKeys = new Set(current.keys());
}

function tick(): void {
  const s = state();
  s.branchResolver?.refresh?.();
  for (const seg of s.segments) seg.refresh?.();
  for (const seg of s.rightSegments) seg.refresh?.();
  syncStatuses();
}

function ensureTimer(): void {
  const s = state();
  if (!s.setStatus || !hasRefreshContributor()) {
    stopTimer();
    return;
  }
  if (!s.timer) s.timer = setInterval(tick, REFRESH_MS);
}

function stopTimer(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export function requestFooterRender(): void {
  syncStatuses();
}

/** Publish a custom branch/status value under the cpi status row. */
export function setBranchResolver(
  produce: Producer,
  refresh?: () => void,
): void {
  state().branchResolver = { produce, refresh };
  syncStatuses();
  ensureTimer();
}

export function clearBranchResolver(): void {
  state().branchResolver = null;
  syncStatuses();
  ensureTimer();
}

/** Add custom status text to the status row; idempotent by name. */
export function registerLineSegment(
  name: string,
  produce: Producer,
  refresh?: () => void,
): void {
  const s = state();
  if (!s.segments.some((seg) => seg.name === name)) {
    s.segments.push({ name, produce, refresh });
    syncStatuses();
    ensureTimer();
  }
}

export function clearLineSegment(name: string): void {
  const s = state();
  const i = s.segments.findIndex((seg) => seg.name === name);
  if (i >= 0) s.segments.splice(i, 1);
  syncStatuses();
  ensureTimer();
}

/** Add custom status text to the status row; idempotent by name. */
export function registerRightSegment(
  name: string,
  produce: Producer,
  refresh?: () => void,
): void {
  const s = state();
  if (!s.rightSegments.some((seg) => seg.name === name)) {
    s.rightSegments.push({ name, produce, refresh });
    syncStatuses();
    ensureTimer();
  }
}

export function clearRightSegment(name: string): void {
  const s = state();
  const i = s.rightSegments.findIndex((seg) => seg.name === name);
  if (i >= 0) s.rightSegments.splice(i, 1);
  syncStatuses();
  ensureTimer();
}

export function setupCpiFooter(_pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  const s = state();
  stopTimer();
  s.setStatus = (key, value) => ctx.ui.setStatus(key, value);
  syncStatuses();
  ensureTimer();
}

export function disposeCpiFooter(): void {
  const s = state();
  for (const key of s.activeStatusKeys) {
    s.setStatus?.(key, undefined);
  }
  s.activeStatusKeys.clear();
  stopTimer();
  s.setStatus = undefined;
}
