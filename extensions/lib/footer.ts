/**
 * Shared cpi footer.
 *
 * Owns the footer for all cpi extensions, renders line 1 itself (so
 * extensions can add information there), and delegates lines 2/3 to the
 * built-in `FooterComponent` (token stats, context %, thinking level,
 * `(auto)`, extension statuses from `setStatus`). Line 1 is the only line
 * with no built-in per-line render API, so it is the seam we own; the rest
 * is spliced from the built-in render to avoid reimplementing it.
 *
 * Why own at all: pi has no `registerVcsProvider` hook and `setFooter`
 * replaces (does not stack). To put jj (or any non-git VCS / extra info)
 * on line 1, one extension must own the footer. Centralizing that here
 * keeps a single owner and lets extensions contribute line-1 segments
 * without each calling `setFooter`.
 *
 * Sharing: pi loads each extension via jiti with `moduleCache: false`, so
 * each extension gets its own module graph — module-level state here would
 * NOT be shared between importers. State is therefore backed by a single
 * `globalThis` slot, which is process-wide and identical across jiti loads.
 *
 * Line-1 composition:
 *   ~/{cwd} ({branch} | {seg1} | {seg2}) • {session-name}
 * branch defaults to the built-in git branch; `setBranchResolver` overrides
 * it (e.g. jj change id, falling back to git). Extra segments via
 * `registerLineSegment`. Empty groups are dropped.
 */

import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI, Theme } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { resolve, relative, sep, isAbsolute } from "node:path";

// ── Constants ───────────────────────────────────────────────────────────────

const REFRESH_MS = 2000;
const SEGMENT_SEP = " | ";
const GLOBAL_KEY = "__cpiFooter";

// ── Types ──────────────────────────────────────────────────────────────────

type Maybe<T> = T | null | undefined;
type Producer = () => Maybe<string>;

interface Contributor {
  name?: string;
  produce: Producer;
  refresh?: () => void;
}

type FooterData = Parameters<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>[2];

interface FooterState {
  branchResolver: Contributor | null;
  segments: Contributor[];
  activeTui: TUI | undefined;
  timer: ReturnType<typeof setInterval> | null;
}

// ── Process-wide shared state (globalThis, see header) ───────────────────────

function state(): FooterState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      branchResolver: null,
      segments: [],
      activeTui: undefined,
      timer: null,
    } satisfies FooterState;
  }
  return g[GLOBAL_KEY] as FooterState;
}

// ── Refresh timer ───────────────────────────────────────────────────────────
// Started only when a contributor needs polling (e.g. jj, which emits no pi
// event). The built-in git watcher drives re-renders via
// footerData.onBranchChange -> ui.requestRender, so pure-git repos with no
// contributors incur no polling.

function tick(): void {
  const s = state();
  s.branchResolver?.refresh?.();
  for (const seg of s.segments) seg.refresh?.();
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

// ── Public registration API ─────────────────────────────────────────────────

/** Override the branch source. Return null/undefined to fall back to git. */
export function setBranchResolver(produce: Producer, refresh?: () => void): void {
  state().branchResolver = { produce, refresh };
  ensureTimer();
}

export function clearBranchResolver(): void {
  state().branchResolver = null;
}

/** Add an extra parenthetical group on line 1. Idempotent by name. */
export function registerLineSegment(name: string, produce: Producer, refresh?: () => void): void {
  const s = state();
  if (!s.segments.some((seg) => seg.name === name)) {
    s.segments.push({ name, produce, refresh });
    ensureTimer();
  }
}

/** Remove a previously registered line-1 segment by name. */
export function clearLineSegment(name: string): void {
  const s = state();
  const i = s.segments.findIndex((seg) => seg.name === name);
  if (i >= 0) s.segments.splice(i, 1);
}

// ── Line-1 rendering ────────────────────────────────────────────────────────

/** Replicates built-in formatCwdForFooter (not package-exported). */
function formatCwd(cwd: string, home: string | undefined): string {
  if (!home) return cwd;
  const rcwd = resolve(cwd);
  const rhome = resolve(home);
  const rel = relative(rhome, rcwd);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

function renderLine1(
  ctx: ExtensionContext,
  theme: Theme,
  width: number,
  footerData: FooterData,
): string {
  const s = state();
  const cwd = formatCwd(ctx.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);
  const branch = s.branchResolver?.produce() ?? footerData.getGitBranch();
  const groups: string[] = [];
  if (branch) groups.push(branch);
  for (const seg of s.segments) {
    const v = seg.produce();
    if (v) groups.push(v);
  }
  let line = cwd;
  if (groups.length > 0) line += ` (${groups.join(SEGMENT_SEP)})`;
  const sessionName = ctx.sessionManager.getSessionName();
  if (sessionName) line += ` • ${sessionName}`;
  return truncateToWidth(theme.fg("dim", line), width, theme.fg("dim", "…"));
}

// ── Footer ownership ────────────────────────────────────────────────────────

// Suppresses repeated stderr noise if a future pi FooterComponent.render reads
// an AgentSession field the shim omits and throws per-render.
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
    };
    // The shim omits setAutoCompactEnabled, so FooterComponent keeps its
    // default (autoCompactEnabled = true). Spliced lines 2/3 therefore always
    // show "(auto)" even when real auto-compact is disabled; there is no
    // public ExtensionContext API to read the real setting. Do not fake it.
    const builtin = new FooterComponent(sessionLike, real);
    // Re-render on pure-git branch changes (no contributor polling needed).
    const unsubBranch = real.onBranchChange(() => tui.requestRender());
    return {
      render(width: number): string[] {
        try {
          const lines = builtin.render(width);
          if (lines.length === 0) return [renderLine1(ctx, theme, width, real)];
          // Splice: keep built-in lines 2/3 (stats + statuses), replace line 1.
          lines[0] = renderLine1(ctx, theme, width, real);
          return lines;
        } catch (err) {
          // Future pi may read an AgentSession field the shim omits.
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
        // Timer is shared; cleared on session shutdown.
      },
    };
  });
}

export function disposeCpiFooter(): void {
  stopTimer();
  state().activeTui = undefined;
}
