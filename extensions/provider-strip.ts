/**
 * Provider strip extension — behavior 1 (startup).
 *
 * Upon pi start:
 *   1. Register all providers from the merged fallback config.
 *   2. Strip unusable providers via configurable provider:auth matching
 *      (the `strip` rules; defaults to env-based bedrock/huggingface so
 *      ambient cloud creds don't shadow real providers).
 *   3. If the active model is missing or was just stripped, pick the first
 *      fallback candidate whose context window fits.
 *
 * Config lives in fallback-providers.json (see lib/provider-config.ts).
 * Pure startup concern — runtime failover lives in provider-failover.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  loadMergedConfig,
  registerProviderConfig,
  storeConfig,
  selectFallback,
  stripMatches,
  DEFAULT_STRIP_RULES,
} from "./lib/provider-config";

const debug = (msg: string): void => {
  if (process.env.PF_DEBUG) process.stderr.write(`[provider-strip] ${msg}\n`);
};

export default async function (pi: ExtensionAPI): Promise<void> {
  // Factory: register providers from process.cwd() config (best guess before
  // session_start gives the real ctx.cwd). session_start re-registers any
  // ctx.cwd-only providers idempotently.
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
        debug(`${rule.provider}: auth-match not fired, keeping`);
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
      debug(`active ${cur!.provider}/${cur!.id} usable; skipping startup pick`);
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
    debug(`startup setModel(${pick.candidate.provider}/${pick.candidate.model}) -> ${ok}`);
    if (ok) {
      const text = `No usable model; using ${pick.candidate.provider} / ${pick.candidate.model}.`;
      process.stderr.write(`[provider-strip] ${text}\n`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
    }
  });
}
