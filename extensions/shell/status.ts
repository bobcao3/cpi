import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  clearRightSegment,
  registerRightSegment,
  requestFooterRender,
} from "../lib/footer.ts";
import { getBackgroundCount } from "./exec.ts";
import { getRepeatCount } from "./repeat.ts";
import { listActivities } from "../lib/activity.ts";

const SEGMENT_NAME = "shell";
const REFRESH_MS = 1000;

export interface ShellStatusRefresher {
  refresh: () => void;
  dispose: () => void;
}

function shellStatusValue(session_id?: string): string | undefined {
  const parts: string[] = [];
  const history = listActivities(session_id);
  const live = history.filter(
    (entry) => entry.status === "running" || entry.status === "stopping",
  );
  const shells = Math.max(
    getBackgroundCount(),
    live.filter((entry) => entry.kind === "shell").length,
  );
  const rpt = Math.max(
    getRepeatCount(),
    live.filter((entry) => entry.kind === "monitor").length,
  );
  if (shells > 0 || history.some((entry) => entry.kind === "shell"))
    parts.push(`shell:${shells}`);
  if (rpt > 0 || history.some((entry) => entry.kind === "monitor"))
    parts.push(`mon:${rpt}`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function createShellStatusRefresher(
  ctx: ExtensionContext,
): ShellStatusRefresher {
  const session_id = ctx.sessionManager.getSessionId();
  const produce = () => shellStatusValue(session_id);
  registerRightSegment(SEGMENT_NAME, produce);

  let lastValue: string | undefined;
  const refresh = () => {
    if (!ctx.hasUI) return;
    const value = produce();
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
