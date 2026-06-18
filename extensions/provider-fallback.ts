/**
 * Provider fallback extension.
 *
 * Reads fallback provider/model candidates from two JSON files, merges them,
 * registers all providers, and selects the first working model at session
 * start when no usable model is active.
 *
 * Config files (JSON, loaded in order — project overrides user):
 *   1. ~/.pi/agent/fallback-providers.json   (user-scoped)
 *   2. <cwd>/.pi/fallback-providers.json      (project-scoped)
 *
 * Schema:
 *   {
 *     "providers": {
 *       "<provider-key>": {
 *         "name": "Display name",
 *         "baseUrl": "https://...",
 *         "api": "openai-completions",
 *         "apiKey": "NO",
 *         "compat": { ... },              // optional, relocated onto each model
 *         "models": [
 *           {
 *             "id": "model-id",
 *             "name": "Model Name",         // optional
 *             "reasoning": true,             // optional
 *             "input": ["text", "image"],    // optional
 *             "cost": { ... },               // optional
 *             "contextWindow": 262144,        // optional
 *             "maxTokens": 16384,            // optional
 *             "compat": { ... }              // optional, overrides provider/defaults
 *           }
 *         ]
 *       }
 *     },
 *     "fallbacks": [
 *       { "provider": "<provider-key>", "model": "<model-id>" }
 *     ]
 *   }
 *
 * Merge rules:
 *   - providers: deep merge — project entries override user entries by key;
 *     within a provider, project's models array replaces user's if present.
 *   - fallbacks: project list replaces user list entirely (so projects can
 *     reorder or prune). If project has no fallbacks key, user's are kept.
 *
 * At session start:
 *   1. Disable env-based bedrock / huggingface (hardcoded detection — those
 *      ambient creds shadow real providers in cloud environments).
 *   2. If no usable model is active (or it was just disabled), try each
 *      fallback candidate in order until setModel succeeds.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── debug ────────────────────────────────────────────────────────────────────

const debug = (msg: string) => {
  if (process.env.PF_DEBUG) {
    try {
      appendFileSync("/tmp/provider-fallback-debug.log", `${msg}\n`);
    } catch {
      // ignore
    }
  }
};

// ── types ────────────────────────────────────────────────────────────────────

/**
 * OpenAI-completions compatibility overrides. Only the fields we care about are
 * named; the rest pass through. See pi-ai's openai-completions `getCompat`.
 */
interface CompatConfig {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: string;
  requiresReasoningContentOnAssistantMessages?: boolean;
  thinkingFormat?: string;
  [key: string]: unknown;
}

interface ProviderModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: Record<string, number>;
  contextWindow?: number;
  maxTokens?: number;
  compat?: CompatConfig;
}

interface ProviderConfig {
  name?: string;
  baseUrl: string;
  api: string;
  apiKey?: string;
  /**
   * Provider-level compat is accepted for convenience but the framework's
   * dynamic registerProvider path ignores it (only model-level compat is read).
   * `normalizeCompat` relocates it onto each model, so this is never sent as-is.
   */
  compat?: CompatConfig;
  models: ProviderModel[];
}

interface FallbackCandidate {
  provider: string;
  model: string;
}

interface FallbackConfig {
  providers?: Record<string, ProviderConfig>;
  fallbacks?: FallbackCandidate[];
}

// ── cost normalization ───────────────────────────────────────────────────────

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Ensure every model in a provider config has a `cost` object. The framework's
 * dynamic `registerProvider` path does not default this (the models.json path
 * does), and `calculateCost` dereferences `model.cost.input` unconditionally.
 * Mutates in place; missing fields are filled with 0.
 */
function withDefaultCosts(pcfg: ProviderConfig): void {
  for (const model of pcfg.models ?? []) {
    model.cost = { ...ZERO_COST, ...(model.cost ?? {}) };
  }
}

// ── compat normalization ───────────────────────────────────────────────────

/**
 * Conservative compat defaults for self-hosted, OpenAI-compatible endpoints
 * (SGLang / vLLM), which is what every provider in these configs is.
 *
 * - `supportsDeveloperRole: false` — these servers' chat templates generally do
 *   NOT understand the `developer` role. pi sends the system prompt under
 *   `developer` for reasoning models when this is left on (auto-detected true
 *   for unrecognized URLs), and templates like GLM-5.2's silently drop it,
 *   losing the entire system prompt (CWD, guidelines, skills). Force `system`.
 * - `maxTokensField: "max_tokens"` — SGLang/vLLM use the classic field, not
 *   OpenAI's newer `max_completion_tokens`.
 *
 * A model (or provider) can override any of these by setting its own compat.
 */
const DEFAULT_COMPAT: CompatConfig = {
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
};

/**
 * Validate a provider config and fold compat down onto each model.
 *
 * The framework's dynamic registerProvider path (model-registry.js
 * `applyProviderConfig`) only reads model-level `compat` — a provider-level
 * `compat` block is silently ignored (unlike the models.json path, which
 * merges it). So we relocate any provider-level compat onto every model and
 * apply conservative defaults. Precedence (low → high):
 *
 *   DEFAULT_COMPAT  <  provider.compat  <  model.compat
 *
 * Returns human-readable warnings for malformed entries (does not throw —
 * a bad provider should be skipped, not crash startup). Mutates in place.
 */
function validateAndNormalizeCompat(key: string, pcfg: ProviderConfig): string[] {
  const warnings: string[] = [];

  if (!pcfg.baseUrl) warnings.push(`provider "${key}": missing baseUrl`);
  if (!pcfg.api) warnings.push(`provider "${key}": missing api`);
  if (!Array.isArray(pcfg.models) || pcfg.models.length === 0) {
    warnings.push(`provider "${key}": no models defined`);
  }

  const providerCompat = pcfg.compat;
  if (providerCompat) {
    warnings.push(
      `provider "${key}": provider-level "compat" is ignored by the framework; ` +
        `relocating it onto each model (set compat per-model to silence this)`,
    );
    delete pcfg.compat;
  }

  for (const model of pcfg.models ?? []) {
    if (!model.id) warnings.push(`provider "${key}": a model is missing "id"`);
    model.compat = {
      ...DEFAULT_COMPAT,
      ...providerCompat,
      ...model.compat,
    };
  }

  return warnings;
}

// ── env-based provider detection ─────────────────────────────────────────────

const has = (key: string): boolean => !!process.env[key]?.trim();

/** Returns true if the provider's auth is purely from environment variables. */
function isEnvBasedProvider(name: string): boolean {
  switch (name) {
    case "amazon-bedrock":
      return (
        has("AWS_PROFILE") ||
        (has("AWS_ACCESS_KEY_ID") && has("AWS_SECRET_ACCESS_KEY")) ||
        has("AWS_BEARER_TOKEN_BEDROCK") ||
        has("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI") ||
        has("AWS_CONTAINER_CREDENTIALS_FULL_URI") ||
        has("AWS_WEB_IDENTITY_TOKEN_FILE")
      );
    case "huggingface":
      return has("HF_TOKEN");
    default:
      return false;
  }
}

/** Providers to disable when their auth is env-based. */
const ENV_PROVIDERS_TO_DISABLE = ["amazon-bedrock", "huggingface"];

// ── config loading & merging ─────────────────────────────────────────────────

function loadConfigFile(path: string): FallbackConfig | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as FallbackConfig;
  } catch (err) {
    process.stderr.write(`[provider-fallback] failed to parse ${path}: ${err}\n`);
    return null;
  }
}

/** Deep merge: project providers override user providers by key; project fallbacks replace user fallbacks. */
function mergeConfigs(user: FallbackConfig | null, project: FallbackConfig | null): FallbackConfig {
  const merged: FallbackConfig = {};

  // providers: deep merge by key; project's models array replaces user's
  const allProviderKeys = new Set([
    ...Object.keys(user?.providers ?? {}),
    ...Object.keys(project?.providers ?? {}),
  ]);
  if (allProviderKeys.size > 0) {
    merged.providers = {};
    for (const key of allProviderKeys) {
      const u = user?.providers?.[key];
      const p = project?.providers?.[key];
      if (p) {
        merged.providers[key] = p; // project fully overrides
      } else if (u) {
        merged.providers[key] = u;
      }
    }
  }

  // fallbacks: project list replaces user list; otherwise keep user's
  merged.fallbacks = project?.fallbacks ?? user?.fallbacks ?? [];

  return merged;
}

function loadMergedConfig(cwd: string): FallbackConfig {
  const userPath = join(process.env.HOME ?? "", ".pi", "agent", "fallback-providers.json");
  const projectPath = join(cwd, ".pi", "fallback-providers.json");

  const user = loadConfigFile(userPath);
  const project = loadConfigFile(projectPath);

  debug(`user config: ${user ? `${userPath} (${user.fallbacks?.length ?? 0} fallbacks)` : "none"}`);
  debug(
    `project config: ${project ? `${projectPath} (${project.fallbacks?.length ?? 0} fallbacks)` : "none"}`,
  );

  return mergeConfigs(user, project);
}

// ── extension ────────────────────────────────────────────────────────────────

/**
 * Register a single provider config idempotently.
 *
 * Defaults each model's `cost` (the framework's dynamic registerProvider path
 * stores `cost` verbatim with no default, unlike the models.json path; a model
 * without `cost` leaves model.cost undefined and calculateCost then throws
 * "Cannot read properties of undefined (reading 'input')" on the first turn),
 * folds compat down onto each model with conservative defaults, then calls
 * pi.registerProvider. Records `key` in `registered` and is a no-op if the key
 * is already present, so the factory and session_start can both walk their
 * respective configs without double-registering. Errors are caught and warned,
 * never thrown — a bad provider is skipped, not crashed.
 */
function registerProviderConfig(
  pi: ExtensionAPI,
  key: string,
  pcfg: ProviderConfig,
  registered: Set<string>,
): void {
  if (registered.has(key)) {
    debug(`provider already registered: ${key}`);
    return;
  }
  try {
    withDefaultCosts(pcfg);

    for (const w of validateAndNormalizeCompat(key, pcfg)) {
      process.stderr.write(`[provider-fallback] ${w}\n`);
      debug(w);
    }

    pi.registerProvider(key, pcfg as Parameters<typeof pi.registerProvider>[1]);
    debug(`registered provider: ${key}`);
    registered.add(key);
  } catch (err) {
    console.warn(`[provider-fallback] registerProvider(${key}) failed:`, err);
  }
}

export default async function (pi: ExtensionAPI) {
  // We need the cwd for project-scoped config. The factory runs before
  // session_start, so we use process.cwd() as a best guess. session_start
  // will have the real ctx.cwd but providers must be registered here.
  const config = loadMergedConfig(process.cwd());
  const registered = new Set<string>();

  // Register all providers from the merged config. Queued during initial
  // load and drained before model resolution.
  if (config.providers) {
    for (const [key, pcfg] of Object.entries(config.providers)) {
      registerProviderConfig(pi, key, pcfg, registered);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Reload config with the real cwd from ctx, in case it differs.
    const liveConfig = loadMergedConfig(ctx.cwd);

    debug(
      `session_start: ctx.model=${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "undefined"}`,
    );
    debug(
      `merged fallbacks: ${(liveConfig.fallbacks ?? []).map((f) => `${f.provider}/${f.model}`).join(", ") || "none"}`,
    );

    // Register any providers in the live (ctx.cwd) config that weren't in the
    // factory's process.cwd() config — e.g. a fork/resume into a different
    // project whose .pi/fallback-providers.json defines new providers.
    // Without this, modelRegistry.find(provider, modelId) returns null and
    // fallbacks referencing those providers silently fail. Idempotent:
    // registerProviderConfig skips already-registered keys.
    if (liveConfig.providers) {
      for (const [key, pcfg] of Object.entries(liveConfig.providers)) {
        registerProviderConfig(pi, key, pcfg, registered);
      }
    }

    // 1. Disable env-based providers that shadow real ones.
    const disabled: string[] = [];
    for (const name of ENV_PROVIDERS_TO_DISABLE) {
      const isEnv = isEnvBasedProvider(name);
      debug(`  ${name}: envBased=${isEnv}`);
      if (isEnv) {
        try {
          pi.unregisterProvider(name);
          disabled.push(name);
        } catch (err) {
          console.warn(`[provider-fallback] unregisterProvider(${name}) failed:`, err);
        }
      }
    }
    if (disabled.length) {
      process.stderr.write(
        `[provider-fallback] disabled env-based providers: ${disabled.join(", ")}\n`,
      );
    }

    // 2. If a working model is active and wasn't just disabled, leave it alone.
    const cur = ctx.model;
    const activeDisabled =
      !!cur && typeof cur.provider === "string" && disabled.includes(cur.provider);
    if (cur && !activeDisabled) {
      debug(`active model ${cur.provider}/${cur.id} is usable; skipping fallback`);
      return;
    }

    // 3. Try each fallback candidate in order until one works.
    const fallbacks = liveConfig.fallbacks ?? [];
    if (fallbacks.length === 0) {
      debug("no fallback candidates configured");
      return;
    }

    for (const { provider, model: modelId } of fallbacks) {
      const model = ctx.modelRegistry.find(provider, modelId);
      debug(`trying fallback: ${provider}/${modelId} found=${!!model}`);
      if (!model) {
        debug(`  ${provider}/${modelId} not in registry (provider may not be registered)`);
        continue;
      }

      const ok = await pi.setModel(model);
      debug(`  setModel -> ${ok}`);
      if (ok) {
        const text = `No usable model; falling back to ${provider} / ${modelId}.`;
        process.stderr.write(`[provider-fallback] ${text}\n`);
        if (ctx.hasUI) {
          ctx.ui.notify(text, "info");
        }
        return; // success — stop trying
      }
    }

    // All fallbacks exhausted
    const text = `Tried ${fallbacks.length} fallback candidate(s); none had a usable API key.`;
    process.stderr.write(`[provider-fallback] ${text}\n`);
    if (ctx.hasUI) {
      ctx.ui.notify(text, "warning");
    }
  });
}
