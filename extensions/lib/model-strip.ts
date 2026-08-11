import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export interface ModelStripRule {
  model: string;
  provider?: string;
  whenAvailable?: string;
}

type NativeProvider = NonNullable<
  ReturnType<ExtensionContext["modelRegistry"]["getProvider"]>
>;
type ProviderModel = ReturnType<NativeProvider["getModels"]>[number];

interface CompiledRule {
  model: RegExp;
  provider?: RegExp;
  whenAvailable?: RegExp;
}

interface ProviderState {
  source: NativeProvider;
  wrapper: NativeProvider;
  rules: CompiledRule[];
}

const MAX_RULES = 128;
const MAX_PATTERN_LENGTH = 512;

export const DEFAULT_MODEL_STRIP_RULES: ModelStripRule[] = [
  {
    model: "(?:^|[./])gpt-5\\.[345](?:$|[-:])",
    whenAvailable: "(?:^|[./])gpt-5\\.6(?:$|[-:])",
  },
  {
    model: "(?:^|[./])deepseek-v4-pro(?:$|:)",
    whenAvailable: "(?:^|[./])deepseek-v4-flash(?:$|:)",
  },
];

function providers(): Map<string, ProviderState> {
  const global = globalThis as unknown as {
    __cpiModelStripProviders?: Map<string, ProviderState>;
  };
  global.__cpiModelStripProviders ??= new Map();
  return global.__cpiModelStripProviders;
}

function compile(source: string, field: string): RegExp | null {
  if (!source || source.length > MAX_PATTERN_LENGTH) {
    process.stderr.write(
      `[provider-strip] ignoring invalid ${field} pattern length\n`,
    );
    return null;
  }
  try {
    return new RegExp(source, "u");
  } catch (error) {
    process.stderr.write(
      `[provider-strip] ignoring invalid ${field} pattern: ${error}\n`,
    );
    return null;
  }
}

function compileRules(rules: ModelStripRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules.slice(0, MAX_RULES)) {
    if (!rule || typeof rule.model !== "string") continue;
    if (rule.provider !== undefined && typeof rule.provider !== "string")
      continue;
    if (
      rule.whenAvailable !== undefined &&
      typeof rule.whenAvailable !== "string"
    )
      continue;
    const model = compile(rule.model, "model");
    const provider =
      typeof rule.provider === "string"
        ? compile(rule.provider, "provider")
        : undefined;
    const whenAvailable =
      typeof rule.whenAvailable === "string"
        ? compile(rule.whenAvailable, "whenAvailable")
        : undefined;
    if (!model || provider === null || whenAvailable === null) continue;
    compiled.push({ model, provider, whenAvailable });
  }
  if (rules.length > MAX_RULES) {
    process.stderr.write(
      `[provider-strip] using first ${MAX_RULES} model strip rules\n`,
    );
  }
  return compiled;
}

function applicableRules(
  rules: CompiledRule[],
  provider: string,
  models: readonly ProviderModel[],
): CompiledRule[] {
  return rules.filter(
    (rule) =>
      (!rule.provider || rule.provider.test(provider)) &&
      (!rule.whenAvailable ||
        models.some((candidate) => rule.whenAvailable!.test(candidate.id))),
  );
}

function strippedModels(
  provider: string,
  source: NativeProvider,
  rules: CompiledRule[],
): ProviderModel[] {
  const models = source.getModels();
  const applicable = applicableRules(rules, provider, models);
  return models.filter((model) =>
    applicable.some((rule) => rule.model.test(model.id)),
  );
}

function createWrapper(
  provider: string,
  source: NativeProvider,
  state: ProviderState,
): NativeProvider {
  return {
    ...source,
    get id() {
      return source.id;
    },
    get name() {
      return source.name;
    },
    get baseUrl() {
      return source.baseUrl;
    },
    get headers() {
      return source.headers;
    },
    get auth() {
      return source.auth;
    },
    getModels() {
      const removed = new Set(
        strippedModels(provider, source, state.rules).map((model) => model.id),
      );
      return source.getModels().filter((model) => !removed.has(model.id));
    },
    filterModels(models, credential) {
      const credentialFiltered = source.filterModels
        ? source.filterModels(models, credential)
        : models;
      const removed = new Set(
        strippedModels(provider, source, state.rules).map((model) => model.id),
      );
      return credentialFiltered.filter((model) => !removed.has(model.id));
    },
    ...(source.refreshModels
      ? { refreshModels: source.refreshModels.bind(source) }
      : {}),
    stream: source.stream.bind(source),
    streamSimple: source.streamSimple.bind(source),
  };
}

export function isModelStripped(provider: string, id: string): boolean {
  const state = providers().get(provider);
  return (
    !!state &&
    strippedModels(provider, state.source, state.rules).some(
      (model) => model.id === id,
    )
  );
}

export function stripModels(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  configuredRules: ModelStripRule[],
): string[] {
  if (
    typeof ctx.modelRegistry.getProvider !== "function" ||
    typeof ctx.modelRegistry.getRegisteredNativeProvider !== "function"
  ) {
    return [];
  }
  const rules = compileRules(
    Array.isArray(configuredRules) ? configuredRules : [],
  );
  const state = providers();
  const providerIds = new Set<string>(state.keys());
  for (const model of ctx.modelRegistry.getAll()) {
    providerIds.add(model.provider);
  }

  for (const provider of providerIds) {
    const existing = state.get(provider);
    if (existing) {
      existing.rules = rules;
      if (
        ctx.modelRegistry.getRegisteredNativeProvider(provider) ===
        existing.wrapper
      ) {
        pi.registerProvider(existing.wrapper);
        continue;
      }
      state.delete(provider);
    }
    const source = ctx.modelRegistry.getProvider(provider);
    if (!source) continue;
    const models = source.getModels();
    const shouldWrap = rules.some(
      (rule) =>
        (!rule.provider || rule.provider.test(provider)) &&
        models.some((model) => rule.model.test(model.id)),
    );
    if (!shouldWrap) continue;
    const next = {} as ProviderState;
    const wrapper = createWrapper(provider, source, next);
    next.source = source;
    next.wrapper = wrapper;
    next.rules = rules;
    pi.registerProvider(wrapper);
    state.set(provider, next);
  }
  return [...state].flatMap(([provider, entry]) =>
    strippedModels(provider, entry.source, entry.rules).map(
      (model) => `${provider}/${model.id}`,
    ),
  );
}
