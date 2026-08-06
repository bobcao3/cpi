/** pi's `_cwd` snapshot is immutable (no mutation API), so setCwd() chdirs
 * the process and tracks the value here — getCwd() stays in lockstep. */

import { isAbsolute, resolve } from "node:path";

const STATE_KEY = "__cpiCwdState";

interface CwdState {
  cwd: string;
}

function state(): CwdState {
  const g = globalThis as Record<string, unknown>;
  const s = g[STATE_KEY] as CwdState | undefined;
  if (s && typeof s === "object") return s;
  const fresh: CwdState = { cwd: process.cwd() };
  g[STATE_KEY] = fresh;
  return fresh;
}

export function getCwd(): string {
  return state().cwd;
}

export function resolveCwdPath(input: string): string {
  return isAbsolute(input) ? input : resolve(state().cwd, input);
}

export function setCwd(target: string): void {
  process.chdir(target);
  state().cwd = target;
}
