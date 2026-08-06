/**
 * Shared provider-fallback config/helpers; config merges project-over-user: ~/.pi/agent/fallback-providers.json then <cwd>/.pi/fallback-providers.json.
 * GlobalThis state survives jiti moduleCache-disabled reloads and prevents duplicate registration.
 */

import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { isModelStripped } from "./model-strip.ts";
import type { ModelStripRule } from "./model-strip.ts";

const debug = (msg: string): void => {
  if (!process.env.PF_DEBUG) return;
  try {
    appendFileSync("/tmp/provider-fallback-debug.log", `${msg}\n`);
  } catch {}
};

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

export interface StripRule {
  provider: string;
  /** Env vars signaling ambient auth. */
  env?: string[];
  /** any matches one; all requires every var. */
  match?: "any" | "all";
}

export interface FailoverConfig {
  failureThreshold?: number;
  /** Counted failure statuses; omitted/null means >=400. */
  statusCodes?: number[] | null;
}

export interface FallbackConfig {
  providers?: Record<string, ProviderConfig>;
  fallbacks?: FallbackCandidate[];
  strip?: StripRule[];
  stripModels?: ModelStripRule[];
  failover?: FailoverConfig;
}

interface ProviderState {
  registered: Set<string>;
  fails: Map<string, number>;
  config: FallbackConfig | null;
  configCwd: string;
}

export function getState(): ProviderState {
  const g = globalThis as unknown as { __cpiProvider?: ProviderState };
  if (!g.__cpiProvider) {
    g.__cpiProvider = {
      registered: new Set(),
      fails: new Map(),
      config: null,
      configCwd: "",
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

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Defaults model costs; dynamic registration does not. */
function withDefaultCosts(pcfg: ProviderConfig): void {
  for (const model of pcfg.models ?? []) {
    model.cost = { ...ZERO_COST, ...(model.cost ?? {}) };
  }
}

const DEFAULT_COMPAT: CompatConfig = {
  supportsDeveloperRole: false,
  maxTokensField: "max_tokens",
};

/** Moves provider compat onto models; mutates and returns warnings. */
function validateAndNormalizeCompat(
  key: string,
  pcfg: ProviderConfig,
): string[] {
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

function loadConfigFile(path: string): FallbackConfig | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as FallbackConfig;
  } catch (err) {
    process.stderr.write(
      `[provider-fallback] failed to parse ${path}: ${err}\n`,
    );
    return null;
  }
}

/** Project providers override by key; project lists replace user lists. */
function mergeConfigs(
  user: FallbackConfig | null,
  project: FallbackConfig | null,
): FallbackConfig {
  const merged: FallbackConfig = {};
  const allKeys = new Set([
    ...Object.keys(user?.providers ?? {}),
    ...Object.keys(project?.providers ?? {}),
  ]);
  if (allKeys.size > 0) {
    merged.providers = {};
    for (const key of allKeys) {
      merged.providers[key] =
        project?.providers?.[key] ?? user?.providers?.[key];
    }
  }
  merged.fallbacks = project?.fallbacks ?? user?.fallbacks ?? [];
  merged.strip = project?.strip ?? user?.strip ?? undefined;
  merged.stripModels = project?.stripModels ?? user?.stripModels ?? undefined;
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

/** Register once; shared state guards duplicates. */
export function registerProviderConfig(
  pi: ExtensionAPI,
  key: string,
  pcfg: ProviderConfig,
): void {
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
    pi.registerProvider(
      key,
      pcfg as unknown as Parameters<typeof pi.registerProvider>[1],
    );
    debug(`registered provider: ${key}`);
    registered.add(key);
  } catch (err) {
    console.warn(`[provider-fallback] registerProvider(${key}) failed:`, err);
  }
}

/** Defaults for configs without strip. */
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

/** Whether configured env vars match. */
export function stripMatches(rule: StripRule): boolean {
  const vars = rule.env ?? [];
  if (vars.length === 0) return false;
  const present = vars.filter((v) => !!process.env[v]?.trim()).length;
  return rule.match === "all" ? present === vars.length : present > 0;
}

export const DEFAULT_FAILURE_THRESHOLD = 3;

export function isFailureStatus(
  status: number,
  cfg: FailoverConfig | undefined,
): boolean {
  const codes = cfg?.statusCodes ?? null;
  return codes ? codes.includes(status) : status >= 400;
}

export interface FallbackPick {
  model: NonNullable<ExtensionContext["model"]>;
  candidate: FallbackCandidate;
}

/** Selects the next registered, unstripped fallback fitting context usage. */
export function selectFallback(
  ctx: ExtensionContext,
  fallbacks: FallbackCandidate[] | undefined,
  afterProvider: string | null,
): FallbackPick | null {
  if (!fallbacks || fallbacks.length === 0) return null;
  const tokens = ctx.getContextUsage()?.tokens ?? 0;
  const startIdx = afterProvider
    ? fallbacks.findIndex((c) => c.provider === afterProvider)
    : -1;
  const begin = startIdx < 0 ? 0 : startIdx + 1;
  for (let i = begin; i < fallbacks.length; i++) {
    const candidate = fallbacks[i];
    const model = ctx.modelRegistry.find(candidate.provider, candidate.model);
    if (!model) {
      debug(
        `fallback ${candidate.provider}/${candidate.model} not in registry`,
      );
      continue;
    }
    if (isModelStripped(candidate.provider, candidate.model)) {
      debug(`fallback ${candidate.provider}/${candidate.model} is stripped`);
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
