/**
 * cpi provider — provider/model lifecycle: startup strip + runtime failover.
 *
 * Two halves of one feature, previously separate extensions
 * (provider-strip + provider-failover). Merged because neither is useful
 * without the other: strip picks the first usable model at startup, failover
 * keeps a usable model across runtime failures. Both read the same merged
 * fallback config (lib/provider-config.ts). One extension = one coherent
 * provider feature; removing it removes the whole feature, not a dangling
 * half.
 *
 *   Startup (session_start):
 *     1. Register all providers from the merged fallback config.
 *     2. Strip unusable providers via configurable provider:auth matching
 *        (the `strip` rules; defaults to env-based bedrock/huggingface so
 *        ambient cloud creds don't shadow real providers).
 *     3. If the active model is missing or was just stripped, pick the first
 *        fallback candidate whose context window fits.
 *
 *   Runtime (turn_end):
 *     When an endpoint fails repeatedly — an assistant turn whose
 *     `stopReason === "error"` (pi surfaces these after exhausting its own
 *     retries) — switch the active model to the next candidate on the
 *     fallback chain, but only if that candidate's context window fits.
 *     Applied at `turn_end` (not deferred to the next `input`): the failed
 *     turn's LLM call is complete when `turn_end` fires, so the request is
 *     no longer in flight; the handler is awaited before pi decides whether
 *     to retry, so `setModel` lands before the next attempt — seamless
 *     failover, no need to re-send the prompt.
 *
 * Config (fallback-providers.json): "failover": { "failureThreshold": 3 }.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_STRIP_RULES,
  getState,
  loadMergedConfig,
  registerProviderConfig,
  selectFallback,
  storeConfig,
  stripMatches,
} from "./lib/provider-config";

const debug = (tag: string, msg: string): void => {
  if (process.env.PF_DEBUG) process.stderr.write(`[${tag}] ${msg}\n`);
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
  debug("provider-failover", `setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`);
  const text = ok
    ? `Switched to ${pick.candidate.provider} / ${pick.candidate.model} after ${from} failures.`
    : `Failover: ${pick.candidate.provider} has no usable API key.`;
  process.stderr.write(`[provider-failover] ${text}\n`);
  if (ctx.hasUI) ctx.ui.notify(text, ok ? "info" : "warning");
}

export default async function providerExtension(pi: ExtensionAPI): Promise<void> {
  // ── Startup: register providers from process.cwd() config (best guess
  // before session_start gives the real ctx.cwd). session_start re-registers
  // any ctx.cwd-only providers idempotently.
  const config = loadMergedConfig(process.cwd());
  if (config.providers) {
    for (const [key, pcfg] of Object.entries(config.providers)) {
      registerProviderConfig(pi, key, pcfg);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const live = loadMergedConfig(ctx.cwd);
    storeConfig(ctx.cwd, live);

    if (live.providers) {
      for (const [key, pcfg] of Object.entries(live.providers)) {
        registerProviderConfig(pi, key, pcfg);
      }
    }

    // 1. Strip unusable providers (configurable; defaults to bedrock/hf).
    const rules = live.strip ?? DEFAULT_STRIP_RULES;
    const stripped: string[] = [];
    for (const rule of rules) {
      if (!stripMatches(rule)) {
        debug("provider-strip", `${rule.provider}: auth-match not fired, keeping`);
        continue;
      }
      try {
        pi.unregisterProvider(rule.provider);
        stripped.push(rule.provider);
      } catch (err) {
        console.warn(`[provider-strip] unregisterProvider(${rule.provider}) failed:`, err);
      }
    }
    if (stripped.length) {
      process.stderr.write(`[provider-strip] stripped: ${stripped.join(", ")}\n`);
    }

    // 2. If the active model is usable (present + not stripped), leave it.
    const cur = ctx.model;
    const curUsable = !!cur && ctx.modelRegistry.find(cur.provider, cur.id) != null;
    if (curUsable) {
      debug("provider-strip", `active ${cur!.provider}/${cur!.id} usable; skipping startup pick`);
      return;
    }

    // 3. Pick the first fallback whose context fits.
    const pick = selectFallback(ctx, live.fallbacks, null);
    if (!pick) {
      const text = "No usable model; no fallback candidate available.";
      process.stderr.write(`[provider-strip] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
      return;
    }
    const ok = await pi.setModel(pick.model);
    debug("provider-strip", `startup setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`);
    if (ok) {
      const text = `No usable model; using ${pick.candidate.provider} / ${pick.candidate.model}.`;
      process.stderr.write(`[provider-strip] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    }
  });

  // ── Runtime failover ───────────────────────────────────────────────────
  // A new model was selected (by us or the user): clear its slate so we don't
  // immediately fail away from a freshly-chosen model.
  pi.on("model_select", (_event, ctx) => {
    const s = getState();
    const provider = ctx.model?.provider;
    if (provider) {
      s.fails.set(provider, 0);
      debug("provider-failover", `model_select: reset fails for ${provider}`);
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
    debug("provider-failover", `${provider}: error turn ${n}/${threshold}`);
    if (n >= threshold) {
      s.fails.set(provider, 0);
      debug("provider-failover", `${provider}: threshold reached; switching`);
      await applyFailover(pi, ctx, provider);
    }
  });
}
