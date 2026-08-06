import {
  deepMerge,
  loadCpiConfig,
  loadDefaultConfig,
  type FastConfig,
} from "./config.ts";

const LIST_ITEMS_MAX = 64;

function stringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || value.length > LIST_ITEMS_MAX) {
    return [...fallback];
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim()) return [...fallback];
    const trimmed = entry.trim();
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function loadFastConfig(cwd: string = process.cwd()): FastConfig {
  const defaults = loadDefaultConfig().fast;
  if (!defaults)
    throw new Error("[cpi-config] shipped fast config is missing.");
  const fast = deepMerge(defaults, loadCpiConfig(cwd).fast ?? {}) as FastConfig;
  return {
    providers: stringList(fast.providers, defaults.providers),
    models: stringList(fast.models, defaults.models),
  };
}
