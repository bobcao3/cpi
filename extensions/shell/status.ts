/** Footer line-1 `bg:N` / `mon:M` segment; polls and re-renders on change (shells complete asynchronously, so a fixed tick alone is too coarse). */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearRightSegment,
  registerRightSegment,
  requestFooterRender,
} from "../lib/footer.ts";
import { getBackgroundCount } from "./exec.ts";
import { getRepeatCount } from "./repeat.ts";

const SEGMENT_NAME = "shell";
const REFRESH_MS = 1000;

export interface ShellStatusRefresher {
  refresh: () => void;
  dispose: () => void;
}

function shellStatusValue(): string | undefined {
  const parts: string[] = [];
  const bg = getBackgroundCount();
  const rpt = getRepeatCount();
  if (bg > 0) parts.push(`bg:${bg}`);
  if (rpt > 0) parts.push(`mon:${rpt}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function createShellStatusRefresher(
  ctx: ExtensionContext,
): ShellStatusRefresher {
  // Idempotent: re-registering on session_start/tree is a no-op after the first.
  registerRightSegment(SEGMENT_NAME, shellStatusValue);

  let lastValue: string | undefined;
  const refresh = () => {
    if (!ctx.hasUI) return;
    const value = shellStatusValue();
    if (value !== lastValue) {
      lastValue = value;
      requestFooterRender();
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
      clearRightSegment(SEGMENT_NAME);
      requestFooterRender();
    },
  };
}
