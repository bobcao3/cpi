import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  clearRightSegment,
  registerRightSegment,
  requestFooterRender,
} from "./lib/footer.ts";
import { codexUsage } from "./lib/provider-usage/codex.ts";
import { deepseekBalance } from "./lib/provider-usage/deepseek.ts";
import {
  sourceForProvider,
  type UsageSource,
} from "./lib/provider-usage/source.ts";

const SEGMENT_NAME = "usage";
const RPC_STATUS_KEY = "provider-usage";
const REQUEST_TIMEOUT_MS = 10_000;
const POLL_MS = 30_000;

const SOURCES: readonly UsageSource<unknown>[] = [codexUsage, deepseekBalance];

interface CachedReport {
  source: UsageSource<unknown>;
  value: unknown;
}

/** One footer segment showing the active provider's quota or credit, if it has a source. */
export default function providerUsageExtension(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let cached: CachedReport | undefined;
  let request:
    | { controller: AbortController; source: UsageSource<unknown> }
    | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setTimeout> | undefined;

  const sourceForContext = (): UsageSource<unknown> | undefined =>
    ctx?.hasUI ? sourceForProvider(SOURCES, ctx.model?.provider) : undefined;

  const cachedForContext = (): CachedReport | undefined => {
    const source = sourceForContext();
    return source && cached?.source === source ? cached : undefined;
  };

  const statusValue = (): string | undefined => {
    const cached = cachedForContext();
    return cached?.source.format(
      cached.value,
      Date.now(),
      ctx?.mode === "tui" ? ctx.ui.theme : undefined,
    );
  };

  const updateFooter = (): void => {
    if (ctx?.mode === "rpc") ctx.ui.setStatus(RPC_STATUS_KEY, statusValue());
    else requestFooterRender();
  };

  const stopTimers = (): void => {
    if (poll) clearInterval(poll);
    if (countdown) clearTimeout(countdown);
    poll = undefined;
    countdown = undefined;
  };

  const scheduleCountdown = (): void => {
    if (countdown) clearTimeout(countdown);
    countdown = undefined;
    const cached = cachedForContext();
    const now = Date.now();
    const at = cached?.source.nextChange?.(cached.value, now);
    if (at === undefined || at <= now) return;
    countdown = setTimeout(() => {
      updateFooter();
      scheduleCountdown();
    }, at - now);
  };

  const refresh = async (): Promise<void> => {
    const source = sourceForContext();
    const target = ctx;
    if (!source || !target) return;
    if (request?.source === source) return;
    request?.controller.abort();
    const controller = new AbortController();
    request = { controller, source };
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const value = await source.fetch(target, controller.signal);
      if (controller.signal.aborted) return;
      cached = value === undefined ? undefined : { source, value };
      updateFooter();
      scheduleCountdown();
    } catch {
    } finally {
      clearTimeout(timeout);
      if (request?.controller === controller) request = undefined;
    }
  };

  const update = async (
    next: ExtensionContext,
    immediate = false,
  ): Promise<void> => {
    ctx = next;
    if (!sourceForContext()) {
      request?.controller.abort();
      request = undefined;
      stopTimers();
      clearRightSegment(SEGMENT_NAME);
      updateFooter();
      return;
    }
    registerRightSegment(SEGMENT_NAME, statusValue);
    if (!poll)
      poll = setInterval(() => {
        void refresh();
      }, POLL_MS);
    updateFooter();
    scheduleCountdown();
    if (immediate) await refresh();
  };

  pi.on("session_start", async (_event, next) => update(next, true));

  pi.on("session_tree", async (_event, next) => update(next));

  pi.on("model_select", async (_event, next) => update(next, true));

  pi.on("session_shutdown", async () => {
    stopTimers();
    request?.controller.abort();
    request = undefined;
    clearRightSegment(SEGMENT_NAME);
    if (ctx?.mode === "rpc") ctx.ui.setStatus(RPC_STATUS_KEY, undefined);
    else requestFooterRender();
    ctx = undefined;
    cached = undefined;
  });
}
