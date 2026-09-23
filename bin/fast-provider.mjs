const OWNER = Symbol.for("cpi.fast.model");
const APIS = new Set(["openai-responses", "openai-codex-responses"]);

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

export function decorateFastProvider(provider, config) {
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
    const catalog = getModels();
    const current = catalog.find((entry) => entry.id === model.id);
    if (model[OWNER] && !current)
      throw new Error(`Fast model unavailable: ${model.provider}/${model.id}`);
    if (!current?.[OWNER])
      return provider[simple ? "streamSimple" : "stream"](
        model[OWNER]
          ? { ...current, baseUrl: model.baseUrl, headers: model.headers }
          : model,
        context,
        options,
      );
    const canonical = {
      ...current[OWNER],
      baseUrl: model.baseUrl,
      headers: model.headers,
    };
    const request = { ...options, serviceTier: "priority" };
    request.onPayload = async (payload, backend) => {
      const transformed = await options?.onPayload?.(payload, backend);
      return {
        ...(transformed ?? payload),
        model: canonical.id,
        service_tier: "priority",
      };
    };
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
      provider[simple ? "streamSimple" : "stream"](
        canonical,
        backendContext,
        request,
      ),
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
