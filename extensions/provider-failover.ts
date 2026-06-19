/**
 * Provider failover extension — behavior 2 (runtime).
 *
 * When an endpoint fails repeatedly — an assistant turn whose
 * `stopReason === "error"` (pi surfaces these after exhausting its own
 * retries, i.e. "pi's limits") — switch the active model to the next
 * candidate on the fallback chain, but only if that candidate's context
 * window fits the current context ("if context allows").
 *
 * Why turn_end, not after_provider_response: the latter fires only on
 * successful (streamable) responses; error responses never reach it.
 * turn_end with stopReason "error" is the reliable per-turn failure signal.
 *
 * Why apply on `input`, not turn_start: pi retries a failed turn in place,
 * re-firing turn_start/turn_end for each retry (and turnIndex is unreliable).
 * Switching mid-retry would race pi's in-flight request and misattribute the
 * old model's errors to the newly-selected one. The `input` event fires once
 * per genuine user prompt, before agent processing, while the agent is idle —
 * the safe point to swap models. So we ARM a switch when the threshold is
 * crossed (turn_end) and APPLY it on the next `input`.
 *
 * Config (fallback-providers.json): "failover": { "failureThreshold": 3 }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

function configFor(ctx: { cwd: string }) {
  const s = getState();
  if (s.config && s.configCwd === ctx.cwd) return s.config;
  const live = loadMergedConfig(ctx.cwd);
  storeConfig(ctx.cwd, live);
  return live;
}

export default async function (pi: ExtensionAPI): Promise<void> {
  // A new model was selected (by us or the user): clear its slate and any
  // armed switch so we don't immediately fail away from a freshly-chosen model.
  pi.on("model_select", (_event, ctx) => {
    const s = getState();
    const provider = ctx.model?.provider;
    if (provider) {
      s.fails.set(provider, 0);
      s.pendingSwitchFrom = null;
      debug(`model_select: reset fails for ${provider}`);
    }
  });

  // Count failed turns per provider; arm a switch at the threshold.
  pi.on("turn_end", (event, ctx) => {
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
      s.pendingSwitchFrom = provider; // apply on next user input (idle)
      debug(`${provider}: threshold reached; failover armed`);
    }
  });

  // Apply an armed switch when the user sends a new prompt (agent idle,
  // before the next turn runs). Avoids racing pi's in-flight request.
  pi.on("input", async (_event, ctx) => {
    const s = getState();
    const from = s.pendingSwitchFrom;
    if (from == null) return;
    s.pendingSwitchFrom = null;

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
    if (ok) {
      const text = `Switched to ${pick.candidate.provider} / ${pick.candidate.model} after ${from} failures.`;
      process.stderr.write(`[provider-failover] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    } else {
      const text = `Failover: ${pick.candidate.provider} has no usable API key.`;
      process.stderr.write(`[provider-failover] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
    }
  });
}
