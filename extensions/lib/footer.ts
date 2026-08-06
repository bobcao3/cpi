/**
 * Shared cpi footer. Line 1 is the seam we own — pi has no per-line render
 * API and `setFooter` replaces (does not stack) — so one extension must own
 * it; lines 2/3 are spliced from the built-in FooterComponent render. State
 * is globalThis-backed: jiti loads each extension with moduleCache:false,
 * so module-level state would not be shared between importers.
 */

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { getCwd } from "./cwd.ts";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { resolve, relative, sep, isAbsolute } from "node:path";

const REFRESH_MS = 2000;
const SEGMENT_SEP = " | ";
const RIGHT_SEP = " ";
const GLOBAL_KEY = "__cpiFooter";

type Maybe<T> = T | null | undefined;
type Producer = () => Maybe<string>;

interface Contributor {
  name?: string;
  produce: Producer;
  refresh?: () => void;
}

type FooterData = Parameters<
  Parameters<ExtensionContext["ui"]["setFooter"]>[0]
>[2];

interface FooterState {
  branchResolver: Contributor | null;
  segments: Contributor[];
  rightSegments: Contributor[];
  activeTui: TUI | undefined;
  timer: ReturnType<typeof setInterval> | null;
}

function state(): FooterState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      branchResolver: null,
      segments: [],
      rightSegments: [],
      activeTui: undefined,
      timer: null,
    } satisfies FooterState;
  }
  return g[GLOBAL_KEY] as FooterState;
}

// Poll only when a contributor needs it; the built-in git watcher covers pure-git repos.

function tick(): void {
  const s = state();
  s.branchResolver?.refresh?.();
  for (const seg of s.segments) seg.refresh?.();
  for (const seg of s.rightSegments) seg.refresh?.();
  s.activeTui?.requestRender();
}

function ensureTimer(): void {
  const s = state();
  if (s.timer || !s.activeTui) return;
  s.timer = setInterval(tick, REFRESH_MS);
}

function stopTimer(): void {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

export function requestFooterRender(): void {
  state().activeTui?.requestRender();
}

/** Override the branch source. Return null/undefined to fall back to git. */
export function setBranchResolver(
  produce: Producer,
  refresh?: () => void,
): void {
  state().branchResolver = { produce, refresh };
  ensureTimer();
}

export function clearBranchResolver(): void {
  state().branchResolver = null;
}

/** Add an extra parenthetical group on line 1; idempotent by name. */
export function registerLineSegment(
  name: string,
  produce: Producer,
  refresh?: () => void,
): void {
  const s = state();
  if (!s.segments.some((seg) => seg.name === name)) {
    s.segments.push({ name, produce, refresh });
    ensureTimer();
  }
}

export function clearLineSegment(name: string): void {
  const s = state();
  const i = s.segments.findIndex((seg) => seg.name === name);
  if (i >= 0) s.segments.splice(i, 1);
}

/** Add a flush-right indicator on line 1; idempotent by name. */
export function registerRightSegment(
  name: string,
  produce: Producer,
  refresh?: () => void,
): void {
  const s = state();
  if (!s.rightSegments.some((seg) => seg.name === name)) {
    s.rightSegments.push({ name, produce, refresh });
    ensureTimer();
  }
}

export function clearRightSegment(name: string): void {
  const s = state();
  const i = s.rightSegments.findIndex((seg) => seg.name === name);
  if (i >= 0) s.rightSegments.splice(i, 1);
}

/** Replicates built-in formatCwdForFooter (not package-exported). */
function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rcwd = resolve(cwd);
  const rhome = resolve(home);
  const rel = relative(rhome, rcwd);
  const inside =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

export function composeLine1(
  left: string,
  right: string,
  width: number,
  style: (s: string) => string,
  ellipsis: string,
): string {
  const leftStyled = style(left);
  if (!right) return truncateToWidth(leftStyled, width, ellipsis);
  const rightStyled = style(right);
  const rightW = visibleWidth(rightStyled);
  if (rightW >= width) return truncateToWidth(rightStyled, width, ellipsis);
  const leftMax = width - rightW - 1; // 1 for the gap between sides
  if (leftMax <= 0) return truncateToWidth(rightStyled, width, ellipsis);
  const leftTrunc = truncateToWidth(leftStyled, leftMax, ellipsis, true);
  return leftTrunc + RIGHT_SEP + rightStyled;
}

function renderLine1(
  ctx: ExtensionContext,
  theme: Theme,
  width: number,
  footerData: FooterData,
): string {
  const s = state();
  const cwd = formatCwd(getCwd(), process.env.HOME || process.env.USERPROFILE);
  const branch = s.branchResolver?.produce() ?? footerData.getGitBranch();
  const groups: string[] = [];
  if (branch) groups.push(branch);
  for (const seg of s.segments) {
    const v = seg.produce();
    if (v) groups.push(v);
  }
  let left = cwd;
  if (groups.length > 0) left += ` (${groups.join(SEGMENT_SEP)})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) left += ` • ${sessionName}`;
  const right = s.rightSegments
    .map((seg) => seg.produce())
    .filter((v): v is string => Boolean(v))
    .join(RIGHT_SEP);
  const dim = (str: string) => theme.fg("dim", str);
  return composeLine1(left, right, width, dim, dim("…"));
}

// Suppresses repeated stderr noise if a future FooterComponent.render throws on a shim-omitted field.
let renderErrorLogged = false;

export function setupCpiFooter(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter((tui, theme, footerData) => {
    const s = state();
    s.activeTui = tui;
    ensureTimer();
    const real = footerData as FooterData;
    const sessionLike = {
      get state() {
        return { model: ctx.model, thinkingLevel: pi.getThinkingLevel() };
      },
      sessionManager: ctx.sessionManager,
      modelRegistry: ctx.modelRegistry,
      getContextUsage: () => ctx.getContextUsage(),
      modelRuntime: {
        // pi 0.80.8+ renders call session.modelRuntime.isUsingOAuth(provider);
        // ExtensionContext exposes no ModelRuntime — proxy via modelRegistry.
        isUsingOAuth: (providerId: string): boolean => {
          if (!ctx.model) return false;
          if (ctx.model.provider !== providerId) return false;
          return ctx.modelRegistry.isUsingOAuth(ctx.model);
        },
      },
    };
    // The shim omits setAutoCompactEnabled, so spliced lines always show
    // "(auto)" even when auto-compact is disabled; no public API to read it.
    const builtin = new FooterComponent(
      sessionLike as unknown as AgentSession,
      real,
    );
    const unsubBranch = real.onBranchChange(() => tui.requestRender());
    return {
      render(width: number): string[] {
        try {
          const lines = builtin.render(width);
          if (lines.length === 0) return [renderLine1(ctx, theme, width, real)];
          lines[0] = renderLine1(ctx, theme, width, real);
          return lines;
        } catch (err) {
          if (!renderErrorLogged) {
            renderErrorLogged = true;
            process.stderr.write(`cpi footer render failed: ${err}\n`);
          }
          return [renderLine1(ctx, theme, width, real)];
        }
      },
      invalidate(): void {
        builtin.invalidate();
      },
      dispose(): void {
        unsubBranch();
        builtin.dispose();
      },
    };
  });
}

export function disposeCpiFooter(): void {
  stopTimer();
  state().activeTui = undefined;
}
