import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";

const OWNER = Symbol.for("cpi.fast.model");
const INSTALLATION = Symbol.for("cpi.fast.runtime");
const CONFIG = Symbol.for("cpi.fast.config");
const APIS = new Set(["openai-responses", "openai-codex-responses"]);
const EFFORT = /:(off|minimal|low|medium|high|xhigh|max)$/;

export function loadFastConfig(cwd = process.cwd()) {
  const defaults = JSON.parse(
    readFileSync(
      new URL("../cpi-config.default.json", import.meta.url),
      "utf8",
    ),
  ).fast;
  let config = { ...defaults };
  for (const path of [
    join(process.env.HOME ?? "", ".pi/agent/cpi-config.json"),
    join(cwd, ".pi/cpi-config.json"),
  ]) {
    try {
      config = { ...config, ...JSON.parse(readFileSync(path, "utf8")).fast };
    } catch (error) {
      if (error.code !== "ENOENT")
        process.stderr.write(`[fast] ${path}: ${error.message}\n`);
    }
  }
  for (const key of ["providers", "models"]) {
    const list = config[key];
    config[key] =
      Array.isArray(list) &&
      list.length <= 64 &&
      list.every((item) => typeof item === "string" && item.trim())
        ? [...new Set(list.map((item) => item.trim()))]
        : [...defaults[key]];
  }
  return config;
}

export function canonicalFastModel(model) {
  return model?.[OWNER]?.id ?? model?.id;
}

export function isGeneratedFastModel(model) {
  return Boolean(model?.[OWNER]);
}

function priorityCost(model) {
  const multiplier = model.id === "gpt-5.5" ? 2.5 : 2;
  const scale = (rates) =>
    Object.fromEntries(
      Object.entries(rates).map(([key, value]) => [
        key,
        ["input", "output", "cacheRead", "cacheWrite"].includes(key)
          ? value * multiplier
          : value,
      ]),
    );
  return {
    ...scale(model.cost),
    ...(model.cost.tiers ? { tiers: model.cost.tiers.map(scale) } : {}),
  };
}

function logicalStream(stream, identity) {
  const restore = (message) => {
    if (message) message.model = identity;
    return message;
  };
  return {
    async *[Symbol.asyncIterator]() {
      for await (const event of stream) {
        restore(event.partial ?? event.message ?? event.error);
        yield event;
      }
    },
    result: async () => restore(await stream.result()),
  };
}

function decorate(provider, config) {
  const getModels = () => {
    const models = provider.getModels();
    const ids = new Set(models.map((model) => model.id));
    const variants = models
      .filter(
        (model) =>
          config.models.includes(model.id) &&
          APIS.has(model.api) &&
          !ids.has(`${model.id}-fast`),
      )
      .map((model) => ({
        ...model,
        id: `${model.id}-fast`,
        name: `${model.name} Fast`,
        cost: priorityCost(model),
        [OWNER]: model,
      }));
    return [...models, ...variants];
  };
  const stream = (model, context, options, simple) => {
    const current = getModels().find((entry) => entry.id === model.id);
    if (model[OWNER] && !current)
      throw new Error(`Fast model unavailable: ${model.provider}/${model.id}`);
    if (!current?.[OWNER])
      return provider[simple ? "streamSimple" : "stream"](
        model[OWNER] ? current : model,
        context,
        options,
      );
    const canonical = {
      ...current[OWNER],
      baseUrl: model.baseUrl,
      headers: model.headers,
    };
    const level = options?.reasoning
      ? clampThinkingLevel(canonical, options.reasoning)
      : undefined;
    const request = simple
      ? {
          ...buildBaseOptions(canonical, context, options, options?.apiKey),
          toolChoice: options?.toolChoice,
          reasoningEffort: level === "off" ? undefined : level,
        }
      : { ...options };
    request.serviceTier = "priority";
    request.onPayload = async (payload, backend) => {
      const transformed = await options?.onPayload?.(payload, backend);
      return {
        ...(transformed ?? payload),
        model: canonical.id,
        service_tier: "priority",
      };
    };
    const catalog = getModels();
    const backendContext = {
      ...context,
      messages: context.messages.map((message) => {
        const source =
          message.role === "assistant" && message.provider === model.provider
            ? catalog.find((entry) => entry.id === message.model)
            : undefined;
        return source?.[OWNER]
          ? { ...message, model: source[OWNER].id }
          : message;
      }),
    };
    return logicalStream(
      provider.stream(canonical, backendContext, request),
      model.id,
    );
  };
  return {
    ...provider,
    getModels,
    stream: (m, c, o) => stream(m, c, o, false),
    streamSimple: (m, c, o) => stream(m, c, o, true),
  };
}

export function installFastModels(
  ModelRuntime,
  config = () => loadFastConfig(),
) {
  const prototype = ModelRuntime.prototype;
  if (prototype[INSTALLATION]) {
    prototype[INSTALLATION].config = config;
    return;
  }
  const installation = { config };
  const compose = prototype.recomposeProvider;
  const prepare = prototype.prepareRequest;
  if (typeof compose !== "function" || typeof prepare !== "function")
    throw new Error(
      "Fast models require ModelRuntime provider composition and request preparation support",
    );
  Object.defineProperty(prototype, INSTALLATION, { value: installation });
  prototype.recomposeProvider = function (id) {
    compose.call(this, id);
    const selected = this[CONFIG] ?? installation.config();
    const provider = this.models.getProvider(id);
    if (provider && selected.providers.includes(id))
      this.models.setProvider(decorate(provider, selected));
  };
  prototype.prepareRequest = async function (model, options) {
    if (
      (model[OWNER] || model.id.endsWith("-fast")) &&
      !this.getModel(model.provider, model.id)
    ) {
      throw new Error(`Fast model unavailable: ${model.provider}/${model.id}`);
    }
    return prepare.call(this, model, options);
  };
}

export async function initializeFastModels(runtime, cwd) {
  runtime[CONFIG] = loadFastConfig(cwd);
  await runtime.refresh({ allowNetwork: false });
}

export function resolveFastModel(resolve, options) {
  const selector = options.cliModel?.toLowerCase().replace(EFFORT, "") ?? "";
  const runtime = options.modelRuntime;
  const models = runtime
    .getModels()
    .filter(
      (model) =>
        !isGeneratedFastModel(model) ||
        selector === model.id.toLowerCase() ||
        selector === `${model.provider}/${model.id}`.toLowerCase(),
    );
  const view = new Proxy(runtime, {
    get: (target, key) =>
      key === "getModels"
        ? () => models
        : typeof target[key] === "function"
          ? target[key].bind(target)
          : target[key],
  });
  const result = resolve({ ...options, modelRuntime: view });
  if (
    selector.endsWith("-fast") &&
    result.model &&
    !runtime.getModel(result.model.provider, result.model.id)
  ) {
    throw new Error(
      `Fast model unavailable: ${result.model.provider}/${result.model.id}`,
    );
  }
  return result;
}
