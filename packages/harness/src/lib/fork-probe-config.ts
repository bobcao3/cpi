import { loadCpiConfig } from "./config.ts";

const CONTEXT_WINDOW_MAX = 16_000_000;

export interface ForkProbeModelRule {
  from: string;
  to: string;
  contextWindow?: number;
}

export function validForkProbeModelRules(
  value: unknown,
): value is ForkProbeModelRule[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(
      (rule) =>
        rule !== null &&
        typeof rule === "object" &&
        !Array.isArray(rule) &&
        [rule.from, rule.to].every(
          (id) =>
            typeof id === "string" &&
            id.length > 0 &&
            Buffer.byteLength(id) <= 256 &&
            id.trim() === id &&
            !/[\x00-\x1f\x7f]/.test(id),
        ) &&
        (rule.contextWindow === undefined ||
          (Number.isSafeInteger(rule.contextWindow) &&
            rule.contextWindow > 0 &&
            rule.contextWindow <= CONTEXT_WINDOW_MAX)),
    )
  );
}

export function loadForkProbeModelRules(cwd: string): ForkProbeModelRule[] {
  const rules = loadCpiConfig(cwd).forkProbe?.substitutions;
  return validForkProbeModelRules(rules) ? rules : [];
}
