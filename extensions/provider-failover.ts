/**
 * Provider failover extension — behavior 2 (runtime).
 *
 * When an endpoint fails repeatedly — an assistant turn whose
 * `stopReason === "error"` (pi surfaces these after exhausting its own
 * retries, i.e. "pi's limits") — switch the active model to the next
 * candidate on the fallback chain, but only if that candidate's context
 * window fits the current context ("if context allows").
 *
 * Why apply at `turn_end` (not deferred to the next `input`): a failed turn's
 * LLM call is complete when `turn_end` fires, so the request is no longer
 * in flight; the handler is awaited before pi decides whether to retry, so
 * `setModel` lands before the next attempt. Switching there lets pi's own
 * remaining retries run against the new model — seamless failover, no need
 * for the user to re-send the prompt. (Switching during `message_update`
 * would race the in-flight stream; `turn_end` does not.)
 *
 * The error just counted is attributed to the provider active at the time of
 * the failure (`ctx.model.provider`, read before `setModel`); after the
 * switch, subsequent turns attribute to the new provider. No misattribution.
 *
 * Config (fallback-providers.json): "failover": { "failureThreshold": 3 }
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getState,
  loadMergedConfig,
  storeConfig,
  selectFallback,
  DEFAULT_FAILURE_THRESHOLD,
} from "./lib/provider-config";

const debug = (msg: string): void => {
  if (process.env.PF_DEBUG) process.stderr.write(`[provider-failover] ${msg}\n`);
};

function configFor(ctx: ExtensionContext) {
  const s = getState();
  if (s.config && s.configCwd === ctx.cwd) return s.config;
  const live = loadMergedConfig(ctx.cwd);
  storeConfig(ctx.cwd, live);
  return live;
}

/** Switch to the next fitting fallback after `from`; notify on outcome. */
async function applyFailover(pi: ExtensionAPI, ctx: ExtensionContext, from: string): Promise<void> {
  const cfg = configFor(ctx);
  const pick = selectFallback(ctx, cfg.fallbacks, from);
  if (!pick) {
    const text = `Failover: no fallback candidate fits after ${from} failures.`;
    process.stderr.write(`[provider-failover] ${text}\n`);
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    return;
  }
  const ok = await pi.setModel(pick.model);
  debug(`failover setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`);
  const text = ok
    ? `Switched to ${pick.candidate.provider} / ${pick.candidate.model} after ${from} failures.`
    : `Failover: ${pick.candidate.provider} has no usable API key.`;
  process.stderr.write(`[provider-failover] ${text}\n`);
  if (ctx.hasUI) ctx.ui.notify(text, ok ? "info" : "warning");
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // A new model was selected (by us or the user): clear its slate so we don't
  // immediately fail away from a freshly-chosen model.
  pi.on("model_select", (_event, ctx) => {
    const s = getState();
    const provider = ctx.model?.provider;
    if (provider) {
      s.fails.set(provider, 0);
      debug(`model_select: reset fails for ${provider}`);
    }
  });

  // Count failed turns per provider; switch to the next fitting fallback once
  // the threshold is crossed. Applied here (between turns) so pi's remaining
  // retries run against the new model.
  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string };
    const provider = ctx.model?.provider;
    if (!provider) return;
    const s = getState();
    const cfg = configFor(ctx);
    const threshold = cfg.failover?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

    const failed = message?.role === "assistant" && message?.stopReason === "error";
    if (!failed) {
      s.fails.set(provider, 0); // recovered — clear this provider's slate
      return;
    }

    const n = (s.fails.get(provider) ?? 0) + 1;
    s.fails.set(provider, n);
    debug(`${provider}: error turn ${n}/${threshold}`);
    if (n >= threshold) {
      s.fails.set(provider, 0);
      debug(`${provider}: threshold reached; switching`);
      await applyFailover(pi, ctx, provider);
    }
  });
}
