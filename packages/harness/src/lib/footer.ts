import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooter,
} from "@earendil-works/pi-coding-agent";
import { FooterNavigation } from "./footer-navigation.ts";
import type { FooterSection } from "./footer-rows.ts";
import { openActivity } from "./activity-ui.ts";
import { getCwd, onCwdChange } from "./cwd.ts";

const REFRESH_MS = 2000;
const GLOBAL_KEY = "__cpiNativeFooter";

type Maybe<T> = T | null | undefined;
type Producer = () => Maybe<string>;

interface Contributor {
  produce: Producer;
  refresh?: () => void;
}

interface FooterState {
  segments: Map<string, Contributor>;
  footer?: ReadonlyFooter;
  requestRender?: () => void;
  updateProject?: () => void;
  restoreFooter?: () => void;
  unsubscribeCwd?: () => void;
  focusActivity?: (returnFocus: (input?: string) => void) => boolean;
  timer: ReturnType<typeof setInterval> | null;
}

// Shared because jiti loads extensions with moduleCache:false.
function state(): FooterState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      segments: new Map(),
      timer: null,
    } satisfies FooterState;
  }
  return g[GLOBAL_KEY] as FooterState;
}

function collectSections(): FooterSection[] {
  const sections: FooterSection[] = [];
  for (const [name, contributor] of state().segments) {
    const value = contributor.produce();
    if (value) sections.push({ name, value });
  }
  return sections;
}

function syncStatuses(): void {
  const s = state();
  s.updateProject?.();
  s.requestRender?.();
}

function tick(): void {
  const s = state();
  for (const seg of s.segments.values()) seg.refresh?.();
  syncStatuses();
}

function ensureTimer(): void {
  const s = state();
  const needsRefresh = [...s.segments.values()].some((seg) => seg.refresh);
  if (!s.requestRender || !needsRefresh) {
    stopTimer();
  } else if (!s.timer) {
    s.timer = setInterval(tick, REFRESH_MS);
  }
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

export function getFooterContent() {
  return state().footer?.getContent();
}

export function focusFooterActivity(
  returnFocus: (input?: string) => void,
): boolean {
  return state().focusActivity?.(returnFocus) ?? false;
}

export function registerLineSegment(
  name: string,
  produce: Producer,
  refresh?: () => void,
): void {
  state().segments.set(name, { produce, refresh });
  syncStatuses();
  ensureTimer();
}

export function clearLineSegment(name: string): void {
  state().segments.delete(name);
  syncStatuses();
  ensureTimer();
}

export const registerRightSegment = registerLineSegment;
export const clearRightSegment = clearLineSegment;

export function setupCpiFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI || ctx.mode !== "tui") return;
  disposeCpiFooter();
  const s = state();
  s.updateProject = () =>
    ctx.ui.setFooterProject({
      cwd: getCwd(),
    });
  s.unsubscribeCwd = onCwdChange(syncStatuses);
  ctx.ui.setFooter((tui, theme, footerData, defaultFooter) => {
    s.footer = defaultFooter;
    s.requestRender = () => tui.requestRender();
    const navigation = new FooterNavigation(
      tui,
      theme,
      defaultFooter,
      () => [
        ...collectSections(),
        ...Array.from(footerData.getExtensionStatuses(), ([name, value]) => ({
          name,
          value: value.replace(/[\r\n\t]/g, " "),
        })),
      ],
      (kind) => {
        void openActivity(ctx, kind).catch((error) =>
          ctx.ui.notify(String(error), "error"),
        );
      },
      () => pi.getThinkingLevel(),
    );
    s.focusActivity = (returnFocus) => navigation.focus(returnFocus);
    return navigation;
  });
  s.restoreFooter = () => {
    ctx.ui.setFooter(undefined);
    ctx.ui.setFooterProject(undefined);
  };
  syncStatuses();
  ensureTimer();
}

export function disposeCpiFooter(): void {
  const s = state();
  s.unsubscribeCwd?.();
  s.unsubscribeCwd = undefined;
  stopTimer();
  s.restoreFooter?.();
  s.restoreFooter = undefined;
  s.requestRender = undefined;
  s.footer = undefined;
  s.updateProject = undefined;
  s.focusActivity = undefined;
}
