/**
 * This registry survives jiti reloads via globalThis; throwing transforms
 * are skipped and logged.
 */

interface TransformEntry {
  apply: (systemPrompt: string, ctx: any, options: any) => string;
  order: number;
}

interface Registry {
  transforms: Map<string, TransformEntry>;
}

const GLOBAL_KEY = "__cpiSystemPrompt";
const DEFAULT_ORDER = 100;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`system-prompt: ${msg}`);
}

function registry(): Registry {
  const g = globalThis as Record<string, unknown>;
  const existing = g[GLOBAL_KEY] as Registry | undefined;
  if (
    existing &&
    typeof existing === "object" &&
    existing.transforms instanceof Map
  ) {
    return existing;
  }
  const fresh: Registry = { transforms: new Map() };
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

export function registerSystemPromptTransform(
  id: string,
  apply: (systemPrompt: string, ctx: any, options: any) => string,
  order: number = DEFAULT_ORDER,
): void {
  assert(
    typeof id === "string" && id.length > 0,
    "id must be a non-empty string",
  );
  assert(typeof apply === "function", "apply must be a function");
  assert(Number.isFinite(order), "order must be a finite number");
  registry().transforms.set(id, { apply, order });
}

export function unregisterSystemPromptTransform(id: string): boolean {
  assert(
    typeof id === "string" && id.length > 0,
    "id must be a non-empty string",
  );
  return registry().transforms.delete(id);
}

export function applySystemPromptTransforms(
  systemPrompt: string,
  ctx: any,
  options: any,
): string {
  const entries = Array.from(registry().transforms.values());
  entries.sort((a, b) => a.order - b.order);
  let out = systemPrompt;
  for (const entry of entries) {
    try {
      out = entry.apply(out, ctx, options);
    } catch (err) {
      process.stderr.write(
        `[system-prompt] transform "${entry.order}" threw: ${err}\n`,
      );
    }
  }
  return out;
}
