/**
 * Shell background-shell / repeat-monitor status bar contribution.
 *
 * Uses ctx.ui.setStatus() so the counts render on the footer's
 * extension-status line of whatever footer is active (built-in or custom).
 * Replaces the earlier custom footer, which collided with other extensions
 * (pi allows only one custom footer at a time) and reimplemented the
 * built-in footer, dropping thinking-level / cache-hit / auto-compact
 * indicators.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getBackgroundCount } from "./exec.ts";
import { getRepeatCount } from "./repeat.ts";

const STATUS_KEY = "shell";
const REFRESH_MS = 1000;
const INIT = Symbol("init");

export interface ShellStatusRefresher {
  refresh: () => void;
  dispose: () => void;
}

export function createShellStatusRefresher(ctx: ExtensionContext): ShellStatusRefresher {
  let lastValue: string | undefined | symbol = INIT;
  const refresh = () => {
    if (!ctx.hasUI) return;
    const parts: string[] = [];
    const bg = getBackgroundCount();
    const rpt = getRepeatCount();
    if (bg > 0) parts.push(`bg:${bg}`);
    if (rpt > 0) parts.push(`mon:${rpt}`);
    const value = parts.length > 0 ? parts.join(" ") : undefined;
    if (value !== lastValue) {
      ctx.ui.setStatus(STATUS_KEY, value);
      lastValue = value;
    }
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  if (ctx.hasUI) timer = setInterval(refresh, REFRESH_MS);
  refresh();

  return {
    refresh,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      ctx.ui.setStatus(STATUS_KEY, undefined);
      lastValue = undefined;
    },
  };
}
