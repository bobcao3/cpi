/**
 * cpi provider — startup strip + runtime failover (one feature). Both read
 * the merged fallback config (lib/provider-config.ts).
 *
 * Startup: register providers, strip unusable ones (defaults: env-based
 * bedrock/huggingface, so ambient creds don't shadow real providers), then
 * pick the first fitting fallback if the active model is gone.
 *
 * Runtime: after `failureThreshold` error turns, switch at turn_end — the
 * failed call is complete and pi awaits this handler before retrying.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MODEL_STRIP_RULES,
  isModelStripped,
  stripModels,
} from "./lib/model-strip";
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
import { getCwd } from "./lib/cwd.ts";

const debug = (tag: string, msg: string): void => {
  if (process.env.PF_DEBUG) process.stderr.write(`[${tag}] ${msg}\n`);
};

function configFor() {
  const s = getState();
  const cwd = getCwd();
  if (s.config && s.configCwd === cwd) return s.config;
  const live = loadMergedConfig(cwd);
  storeConfig(cwd, live);
  return live;
}

async function applyFailover(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  from: string,
): Promise<void> {
  const cfg = configFor();
  const pick = selectFallback(ctx, cfg.fallbacks, from);
  if (!pick) {
    const text = `Failover: no fallback candidate fits after ${from} failures.`;
    process.stderr.write(`[provider-failover] ${text}\n`);
    if (ctx.hasUI) ctx.ui.notify(text, "warning");
    return;
  }
  const ok = await pi.setModel(pick.model);
  debug(
    "provider-failover",
    `setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`,
  );
  const text = ok
    ? `Switched to ${pick.candidate.provider} / ${pick.candidate.model} after ${from} failures.`
    : `Failover: ${pick.candidate.provider} has no usable API key.`;
  process.stderr.write(`[provider-failover] ${text}\n`);
  if (ctx.hasUI) ctx.ui.notify(text, ok ? "info" : "warning");
}

export default async function providerExtension(
  pi: ExtensionAPI,
): Promise<void> {
  // Register providers from the logical cwd — the best value before session_start.
  const config = loadMergedConfig(getCwd());
  if (config.providers) {
    for (const [key, pcfg] of Object.entries(config.providers)) {
      registerProviderConfig(pi, key, pcfg);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    const cwd = getCwd();
    const live = loadMergedConfig(cwd);
    storeConfig(cwd, live);

    if (live.providers) {
      for (const [key, pcfg] of Object.entries(live.providers)) {
        registerProviderConfig(pi, key, pcfg);
      }
    }

    const rules = live.strip ?? DEFAULT_STRIP_RULES;
    const stripped: string[] = [];
    for (const rule of rules) {
      if (!stripMatches(rule)) {
        debug(
          "provider-strip",
          `${rule.provider}: auth-match not fired, keeping`,
        );
        continue;
      }
      try {
        pi.unregisterProvider(rule.provider);
        stripped.push(rule.provider);
      } catch (err) {
        console.warn(
          `[provider-strip] unregisterProvider(${rule.provider}) failed:`,
          err,
        );
      }
    }
    if (stripped.length) {
      process.stderr.write(
        `[provider-strip] stripped: ${stripped.join(", ")}\n`,
      );
    }

    const strippedModelIds = stripModels(
      pi,
      ctx,
      live.stripModels ?? DEFAULT_MODEL_STRIP_RULES,
    );
    if (strippedModelIds.length) {
      process.stderr.write(
        `[model-strip] stripped ${strippedModelIds.length} superseded model${
          strippedModelIds.length === 1 ? "" : "s"
        }.\n`,
      );
      debug("model-strip", `stripped: ${strippedModelIds.join(", ")}`);
    }

    const cur = ctx.model;
    const curUsable =
      !!cur &&
      ctx.modelRegistry.find(cur.provider, cur.id) != null &&
      !isModelStripped(cur.provider, cur.id);
    if (curUsable) {
      debug(
        "provider-strip",
        `active ${cur!.provider}/${cur!.id} usable; skipping startup pick`,
      );
      return;
    }

    const pick = selectFallback(ctx, live.fallbacks, null);
    if (!pick) {
      const text = "No usable model; no fallback candidate available.";
      process.stderr.write(`[provider-strip] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "warning");
      return;
    }
    const ok = await pi.setModel(pick.model);
    debug(
      "provider-strip",
      `startup setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`,
    );
    if (ok) {
      const text = `No usable model; using ${pick.candidate.provider} / ${pick.candidate.model}.`;
      process.stderr.write(`[provider-strip] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    }
  });

  // New model selected (by us or the user): clear its failure slate so we don't fail away from it immediately.
  pi.on("model_select", (_event, ctx) => {
    const s = getState();
    const provider = ctx.model?.provider;
    if (provider) {
      s.fails.set(provider, 0);
      debug("provider-failover", `model_select: reset fails for ${provider}`);
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string };
    const provider = ctx.model?.provider;
    if (!provider) return;
    const s = getState();
    const cfg = configFor();
    const threshold =
      cfg.failover?.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;

    const failed =
      message?.role === "assistant" && message?.stopReason === "error";
    if (!failed) {
      s.fails.set(provider, 0);
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
