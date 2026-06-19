/**
 * Shared provider-fallback config + helpers.
 *
 * Two extensions consume this:
 *   - provider-strip.ts    : startup — register providers, strip unusable
 *                            (configurable provider:auth rules), pick first
 *                            fallback if the active model is unusable.
 *   - provider-failover.ts : runtime — count provider failures and switch to
 *                            the next fallback candidate (if context allows).
 *
 * Config files (JSON, merged — project overrides user):
 *   1. ~/.pi/agent/fallback-providers.json   (user-scoped)
 *   2. <cwd>/.pi/fallback-providers.json      (project-scoped)
 *
 * Shared mutable state lives on globalThis (`__cpiProvider`) because jiti runs
 * with moduleCache disabled — module-level `let` would not survive across the
 * reload boundary and would let two extension instances double-register.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── debug ────────────────────────────────────────────────────────────────────

const debug = (msg: string): void => {
  if (!process.env.PF_DEBUG) return;
  try {
    appendFileSync("/tmp/provider-fallback-debug.log", `${msg}\n`);
  } catch {
    // ignore
  }
};

// ── types ────────────────────────────────────────────────────────────────────

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
  compat?: CompatConfig;
  models: ProviderModel[];
}

interface FallbackCandidate {
  provider: string;
  model: string;
}

/** A startup strip rule: unregister `provider` when its auth-match fires. */
export interface StripRule {
  provider: string;
  /** Env vars whose presence signals ambient (shadowing) auth. */
  env?: string[];
  /** "any" (default) = strip if any env is set; "all" = strip only if all set. */
  match?: "any" | "all";
}

export interface FailoverConfig {
  /** Consecutive failures before switching models. Default 3. */
  failureThreshold?: number;
  /** Status codes counted as failures. null/omit = any status >= 400. */
  statusCodes?: number[] | null;
}

export interface FallbackConfig {
  providers?: Record<string, ProviderConfig>;
  fallbacks?: FallbackCandidate[];
  strip?: StripRule[];
  failover?: FailoverConfig;
}

// ── shared state (globalThis) ────────────────────────────────────────────────

interface ProviderState {
  registered: Set<string>;
  fails: Map<string, number>;
  config: FallbackConfig | null;
  configCwd: string;
  /** Provider that crossed the failure threshold; switch at next turn_start. */
  pendingSwitchFrom: string | null;
}

export function getState(): ProviderState {
  const g = globalThis as unknown as { __cpiProvider?: ProviderState };
  if (!g.__cpiProvider) {
    g.__cpiProvider = {
      registered: new Set(),
      fails: new Map(),
      config: null,
      configCwd: "",
      pendingSwitchFrom: null,
    };
  }
  return g.__cpiProvider;
}

export function storeConfig(cwd: string, config: FallbackConfig): void {
  const s = getState();
  s.config = config;
  s.configCwd = cwd;
}

export function getConfig(): FallbackConfig | null {
  return getState().config;
}

// ── cost normalization ───────────────────────────────────────────────────────

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Default every model's `cost` (dynamic registerProvider does not). Mutates. */
function withDefaultCosts(pcfg: ProviderConfig): void {
  for (const model of pcfg.models ?? []) {
    model.cost = { ...ZERO_COST, ...(model.cost ?? {}) };
  }
}

// ── compat normalization ─────────────────────────────────────────────────────

const DEFAULT_COMPAT: CompatConfig = {
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
};

/** Relocate provider-level compat onto each model; return warnings. Mutates. */
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
    model.compat = { ...DEFAULT_COMPAT, ...providerCompat, ...model.compat };
  }
  return warnings;
}

// ── config loading & merging ─────────────────────────────────────────────────

function loadConfigFile(path: string): FallbackConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FallbackConfig;
  } catch (err) {
    process.stderr.write(`[provider-fallback] failed to parse ${path}: ${err}\n`);
    return null;
  }
}

/** Deep merge: project providers override user by key; project lists replace. */
function mergeConfigs(user: FallbackConfig | null, project: FallbackConfig | null): FallbackConfig {
  const merged: FallbackConfig = {};
  const allKeys = new Set([
    ...Object.keys(user?.providers ?? {}),
    ...Object.keys(project?.providers ?? {}),
  ]);
  if (allKeys.size > 0) {
    merged.providers = {};
    for (const key of allKeys) {
      merged.providers[key] = project?.providers?.[key] ?? user?.providers?.[key];
    }
  }
  merged.fallbacks = project?.fallbacks ?? user?.fallbacks ?? [];
  merged.strip = project?.strip ?? user?.strip ?? undefined;
  merged.failover = project?.failover ?? user?.failover ?? undefined;
  return merged;
}

export function loadMergedConfig(cwd: string): FallbackConfig {
  const user = loadConfigFile(
    join(process.env.HOME ?? "", ".pi", "agent", "fallback-providers.json"),
  );
  const project = loadConfigFile(join(cwd, ".pi", "fallback-providers.json"));
  debug(
    `user config: ${user ? "present" : "none"} | project config: ${project ? "present" : "none"}`,
  );
  return mergeConfigs(user, project);
}

// ── provider registration ────────────────────────────────────────────────────

/** Register one provider idempotently (shared `registered` set guards dupes). */
export function registerProviderConfig(pi: ExtensionAPI, key: string, pcfg: ProviderConfig): void {
  const registered = getState().registered;
  if (registered.has(key)) {
    debug(`provider already registered: ${key}`);
    return;
  }
  try {
    withDefaultCosts(pcfg);
    for (const w of validateAndNormalizeCompat(key, pcfg)) {
      process.stderr.write(`[provider-fallback] ${w}\n`);
    }
    pi.registerProvider(key, pcfg as Parameters<typeof pi.registerProvider>[1]);
    debug(`registered provider: ${key}`);
    registered.add(key);
  } catch (err) {
    console.warn(`[provider-fallback] registerProvider(${key}) failed:`, err);
  }
}

// ── strip rules ──────────────────────────────────────────────────────────────

/** Backward-compatible defaults (used when config has no `strip` section). */
export const DEFAULT_STRIP_RULES: StripRule[] = [
  {
    provider: "amazon-bedrock",
    match: "any",
    env: [
      "AWS_PROFILE",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
    ],
  },
  { provider: "huggingface", match: "any", env: ["HF_TOKEN"] },
];

/** True if the rule's auth-match fires (env vars present per `match`). */
export function stripMatches(rule: StripRule): boolean {
  const vars = rule.env ?? [];
  if (vars.length === 0) return false;
  const present = vars.filter((v) => !!process.env[v]?.trim()).length;
  return rule.match === "all" ? present === vars.length : present > 0;
}

// ── failover defaults ────────────────────────────────────────────────────────

export const DEFAULT_FAILURE_THRESHOLD = 3;

export function isFailureStatus(status: number, cfg: FailoverConfig | undefined): boolean {
  const codes = cfg?.statusCodes ?? null;
  return codes ? codes.includes(status) : status >= 400;
}

// ── fallback selection ───────────────────────────────────────────────────────

export interface FallbackPick {
  model: NonNullable<ExtensionContext["model"]>;
  candidate: FallbackCandidate;
}

/**
 * Pick the next fallback candidate after `afterProvider` (or the first one if
 * null) whose context window fits the current context. "If context allows":
 * skips candidates whose `contextWindow` is smaller than current token usage.
 * Returns null if none fit or none are registered.
 */
export function selectFallback(
  ctx: ExtensionContext,
  fallbacks: FallbackCandidate[] | undefined,
  afterProvider: string | null,
): FallbackPick | null {
  if (!fallbacks || fallbacks.length === 0) return null;
  const tokens = ctx.getContextUsage()?.tokens ?? 0;
  const startIdx = afterProvider ? fallbacks.findIndex((c) => c.provider === afterProvider) : -1;
  const begin = startIdx < 0 ? 0 : startIdx + 1;
  for (let i = begin; i < fallbacks.length; i++) {
    const candidate = fallbacks[i];
    const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
    if (!model) {
      debug(`fallback ${candidate.provider}/${candidate.model} not in registry`);
      continue;
    }
    if (model.contextWindow && model.contextWindow < tokens) {
      debug(
        `fallback ${candidate.provider}/${candidate.model} too small (${model.contextWindow} < ${tokens})`,
      );
      continue;
    }
    return { model, candidate };
  }
  return null;
}
