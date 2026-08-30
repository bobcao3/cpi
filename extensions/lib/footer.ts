/**
 * Shared cpi footer. cpi wraps and delegates to pi's standard footer while
 * publishing all custom contributors through one styled status row. State is
 * globalThis-backed: jiti loads each extension
 * with moduleCache:false, so module-level state would not be shared between
 * importers.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const REFRESH_MS = 2000;
const GLOBAL_KEY = "__cpiFooter";
const SEPARATOR_BACKGROUND_SCALE = 0.55;

type Maybe<T> = T | null | undefined;
type Producer = () => Maybe<string>;

interface Contributor {
  name: string;
  produce: Producer;
  refresh?: () => void;
}

interface FooterState {
  branchResolver: Contributor | null;
  segments: Contributor[];
  rightSegments: Contributor[];
  requestRender: (() => void) | undefined;
  restoreFooter: (() => void) | undefined;
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
      requestRender: undefined,
      restoreFooter: undefined,
      activeStatusKeys: new Set(),
      timer: null,
    } satisfies FooterState;
  } else {
    const s = g[GLOBAL_KEY] as FooterState;
    if (s.branchResolver && typeof s.branchResolver.name !== "string") {
      s.branchResolver.name = "branch";
    }
    s.activeStatusKeys ??= new Set();
    s.requestRender ??= undefined;
    s.restoreFooter ??= undefined;
  }
  return g[GLOBAL_KEY] as FooterState;
}

// Poll only when a contributor needs it; the built-in git watcher covers pure-git repos.

function hasRefreshContributor(): boolean {
  const s = state();
  return Boolean(
    s.branchResolver?.refresh ||
    s.segments.some((seg) => seg.refresh) ||
    s.rightSegments.some((seg) => seg.refresh),
  );
}

function renderSeparator(theme: ExtensionContext["ui"]["theme"]): string {
  const bg = theme.getBgAnsi("customMessageBg");
  const match = bg.match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
  if (!match) return theme.bg("toolPendingBg", " ");
  const [, red, green, blue] = match;
  const scale = (channel: string): number =>
    Math.round(Number(channel) * SEPARATOR_BACKGROUND_SCALE);
  return `\x1b[48;2;${scale(red)};${scale(green)};${scale(blue)}m \x1b[49m`;
}

function renderCpiRows(
  width: number,
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  const s = state();
  const sections: Array<{ name: string; value: string }> = [];
  const branchContributor = s.branchResolver;
  const branch = branchContributor?.produce();
  if (branch && branchContributor) {
    sections.push({ name: branchContributor.name, value: branch });
  }
  for (const seg of s.segments) {
    const value = seg.produce();
    if (value) sections.push({ name: seg.name, value });
  }
  for (const seg of s.rightSegments) {
    const value = seg.produce();
    if (value) sections.push({ name: seg.name, value });
  }
  const priority = (name: string): number => {
    switch (name.toLowerCase()) {
      case "jj":
      case "branch":
        return 0;
      case "fast":
        return 1;
      case "codex":
        return 2;
      case "shell":
        return 3;
      case "subagent-cost":
        return 4;
      case "summary":
        return 6;
      default:
        return 5;
    }
  };
  sections.sort((a, b) => priority(a.name) - priority(b.name));
  const styled = sections.map(({ value }) =>
    theme.bg("customMessageBg", theme.fg("muted", ` ${value} `)),
  );
  const separator = renderSeparator(theme);
  const rendered = styled.reduce(
    (result, section, index) =>
      index === 0 ? section : `${result}${separator}${section}`,
    "",
  );
  if (!rendered) return [];
  if (visibleWidth(rendered) <= width) return [rendered];

  const summaryIndex = sections.findIndex(
    ({ name }) => name.toLowerCase() === "summary",
  );
  if (summaryIndex < 0) return [truncateToWidth(rendered, width)];

  const withoutSummary = styled.filter((_, index) => index !== summaryIndex);
  const first = withoutSummary.reduce(
    (result, section, index) =>
      index === 0 ? section : `${result}${separator}${section}`,
    "",
  );
  return [
    ...(first ? [truncateToWidth(first, width)] : []),
    truncateToWidth(styled[summaryIndex], width),
  ];
}

const MAX_FOOTER_CAPTURE_DEPTH = 4;

function captureFooterLeaf(component: Component): Component {
  let current = component;
  for (let depth = 0; depth < MAX_FOOTER_CAPTURE_DEPTH; depth += 1) {
    const children = (current as Component & { children?: Component[] })
      .children;
    if (!Array.isArray(children) || children.length !== 1) return current;
    current = children[0];
  }
  const children = (current as Component & { children?: Component[] }).children;
  if (Array.isArray(children) && children.length === 1) {
    throw new Error("cpi footer: footer nesting exceeds capture depth");
  }
  return current;
}

function syncStatuses(): void {
  state().requestRender?.();
}

function clearLegacyStatuses(
  setStatus: ExtensionContext["ui"]["setStatus"],
): void {
  const s = state();
  for (const key of s.activeStatusKeys) {
    setStatus(key, undefined);
  }
  setStatus("cpi-footer", undefined);
  s.activeStatusKeys.clear();
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
  if (!s.requestRender || !hasRefreshContributor()) {
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
  state().branchResolver = { name: "branch", produce, refresh };
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
  const existing = s.segments.find((seg) => seg.name === name);
  if (existing) {
    existing.produce = produce;
    existing.refresh = refresh;
  } else {
    s.segments.push({ name, produce, refresh });
  }
  syncStatuses();
  ensureTimer();
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
  const existing = s.rightSegments.find((seg) => seg.name === name);
  if (existing) {
    existing.produce = produce;
    existing.refresh = refresh;
  } else {
    s.rightSegments.push({ name, produce, refresh });
  }
  syncStatuses();
  ensureTimer();
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
  s.restoreFooter = undefined;
  s.requestRender = undefined;
  ctx.ui.setFooter(undefined);
  clearLegacyStatuses((key, value) => ctx.ui.setStatus(key, value));

  let builtInFooter: Component | undefined;
  const captureWidget = "cpi-footer-capture";
  ctx.ui.setWidget(
    captureWidget,
    (tui) => {
      const children = tui.children;
      const rootFooter = children[children.length - 1];
      if (!rootFooter) {
        throw new Error("cpi footer: built-in footer root is missing");
      }
      builtInFooter = captureFooterLeaf(rootFooter);
      return { render: () => [], invalidate: () => {} };
    },
    { placement: "belowEditor" },
  );
  ctx.ui.setWidget(captureWidget, undefined);
  if (!builtInFooter) {
    throw new Error("cpi footer: failed to capture the built-in footer");
  }
  const footer = builtInFooter;

  const restoreFooter = (): void => {
    ctx.ui.setFooter(undefined);
    clearLegacyStatuses((key, value) => ctx.ui.setStatus(key, value));
  };
  ctx.ui.setFooter((tui, theme, _footerData) => {
    s.requestRender = () => tui.requestRender();
    return {
      render(width: number): string[] {
        return [...footer.render(width), ...renderCpiRows(width, theme)];
      },
      invalidate(): void {
        footer.invalidate();
      },
    };
  });
  s.restoreFooter = restoreFooter;
  syncStatuses();
  ensureTimer();
}

export function disposeCpiFooter(): void {
  const s = state();
  s.restoreFooter?.();
  stopTimer();
  s.activeStatusKeys.clear();
  s.requestRender = undefined;
  s.restoreFooter = undefined;
}
