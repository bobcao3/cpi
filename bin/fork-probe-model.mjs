import { canonicalFastModel } from "./fast-models.mjs";

const EFFORT = /:(off|minimal|low|medium|high|xhigh|max)$/;
const MAX_TIERS = 32;

function valid_rates(cost, field) {
  if (!cost || !Number.isFinite(cost[field]) || cost[field] <= 0) return false;
  const tiers = cost.tiers ?? [];
  return (
    Array.isArray(tiers) &&
    tiers.length <= MAX_TIERS &&
    tiers.every(
      (tier) =>
        tier &&
        Number.isSafeInteger(tier.inputTokensAbove) &&
        tier.inputTokensAbove >= 0 &&
        Number.isFinite(tier[field]) &&
        tier[field] > 0,
    ) &&
    new Set(tiers.map((tier) => tier.inputTokensAbove)).size === tiers.length
  );
}

function rate_at(cost, field, tokens) {
  let rate = cost[field];
  let threshold = -1;
  for (const tier of cost.tiers ?? []) {
    if (tokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      rate = tier[field];
      threshold = tier.inputTokensAbove;
    }
  }
  return rate;
}

function cheaper_than_cache(source, target) {
  if (
    !valid_rates(source.cost, "cacheRead") ||
    !valid_rates(target.cost, "input")
  )
    return false;
  const boundaries = [
    0,
    ...(source.cost.tiers ?? []).map((tier) => tier.inputTokensAbove + 1),
    ...(target.cost.tiers ?? []).map((tier) => tier.inputTokensAbove + 1),
  ];
  return boundaries.every(
    (tokens) =>
      rate_at(target.cost, "input", tokens) <
      rate_at(source.cost, "cacheRead", tokens),
  );
}

export function selectForkProbeSubstitute(request, services, manager) {
  const parent = manager.buildSessionContext().model;
  if (!parent) return {};
  const registry = services.modelRuntime;
  const source = registry.getModel(parent.provider, parent.modelId);
  if (!source || !registry.hasConfiguredAuth(source.provider)) return {};
  for (const rule of request.modelSubstitutions ?? []) {
    if (rule.from !== canonicalFastModel(source)) continue;
    const effort = rule.to.match(EFFORT);
    const id = effort ? rule.to.slice(0, effort.index) : rule.to;
    const target = registry.getModel(source.provider, id);
    if (
      !target ||
      target.provider !== source.provider ||
      !(target.contextWindow >= source.contextWindow) ||
      !source.input.every((kind) => target.input.includes(kind)) ||
      !cheaper_than_cache(source, target)
    )
      continue;
    return {
      model: target,
      ...(effort ? { thinkingLevel: effort[1] } : {}),
    };
  }
  return {};
}
