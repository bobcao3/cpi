/**
 * Shared registry for system-prompt transforms.
 *
 * One owner extension (extensions/system-prompt.ts) listens to
 * `before_agent_start` and applies every registered transform to the incoming
 * system prompt, in ascending `order`. Other extensions (caveman, skill)
 * register transforms at factory load instead of each mutating
 * `before_agent_start` themselves — keeping a single listener that owns the
 * final systemPrompt return value, applied in a declared, stable order.
 *
 * Sharing: pi loads each extension via jiti with `moduleCache: false`, so each
 * extension gets its own module graph — module-level state here would NOT be
 * shared between importers. The registry is therefore backed by a single
 * `globalThis` slot, process-wide and identical across jiti loads (same pattern
 * as lib/footer.ts and lib/transcript-registry.ts).
 */

interface TransformEntry {
  apply: (systemPrompt: string, ctx: any) => string;
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
  if (existing && typeof existing === "object" && existing.transforms instanceof Map) {
    return existing;
  }
  const fresh: Registry = { transforms: new Map() };
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

/**
 * Register (or replace) a system-prompt transform by id. Idempotent by id:
 * re-registering with the same id replaces the prior entry (last wins), so
 * reloading an extension cleanly swaps its transform instead of stacking.
 */
export function registerSystemPromptTransform(
  id: string,
  apply: (systemPrompt: string, ctx: any) => string,
  order: number = DEFAULT_ORDER,
): void {
  assert(typeof id === "string" && id.length > 0, "id must be a non-empty string");
  assert(typeof apply === "function", "apply must be a function");
  assert(Number.isFinite(order), "order must be a finite number");
  registry().transforms.set(id, { apply, order });
}

/**
 * Apply every registered transform to `systemPrompt`, in ascending `order`.
 * Ties keep insertion order (Array.prototype.sort is stable). Never throws:
 * a transform that throws is skipped and logged to stderr, so one faulty
 * extension cannot blank the system prompt for the whole process.
 */
export function applySystemPromptTransforms(systemPrompt: string, ctx: any): string {
  const entries = Array.from(registry().transforms.values());
  entries.sort((a, b) => a.order - b.order);
  let out = systemPrompt;
  for (const entry of entries) {
    try {
      out = entry.apply(out, ctx);
    } catch (err) {
      process.stderr.write(`[system-prompt] transform "${entry.order}" threw: ${err}\n`);
    }
  }
  return out;
}
