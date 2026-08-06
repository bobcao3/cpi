/** Session dir for ctx-less leaf modules: core.ts republishes the pi snapshot here at each session_start. */

const STATE_KEY = "__cpiSessionDir";

export function getSessionDir(): string | undefined {
  const g = globalThis as Record<string, unknown>;
  const v = g[STATE_KEY];
  return typeof v === "string" ? v : undefined;
}

export function setSessionDir(dir: string | undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (dir === undefined) delete g[STATE_KEY];
  else g[STATE_KEY] = dir;
}
