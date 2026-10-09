const GLOBAL_KEY = "__cpiCompactionProgress";

interface ProgressState {
  tokens?: number;
  requestRender?: () => void;
}

function state(): ProgressState {
  const global = globalThis as Record<string, unknown>;
  return (global[GLOBAL_KEY] ??= {}) as ProgressState;
}

export function setCompactionRender(request: () => void): void {
  state().requestRender = request;
}

export function beginCompaction(): void {
  const current = state();
  current.tokens = 0;
  current.requestRender?.();
}

export function reportCompactionTokens(tokens: number): void {
  const current = state();
  if (current.tokens === undefined) return;
  current.tokens = tokens;
  current.requestRender?.();
}

export function finishCompaction(): void {
  const current = state();
  current.tokens = undefined;
  current.requestRender?.();
}

export function compactionTokens(): number | undefined {
  return state().tokens;
}
