/** cpi's cwd is logical and stored globally, avoiding process-wide chdir(). */

import { isAbsolute, resolve } from "node:path";

const STATE_KEY = "__cpiCwdState";

interface CwdState {
  cwd: string;
  listeners: Set<() => void>;
}

function state(): CwdState {
  const g = globalThis as Record<string, unknown>;
  const s = g[STATE_KEY] as CwdState | undefined;
  if (s && typeof s === "object") {
    s.listeners ??= new Set();
    return s;
  }
  const fresh: CwdState = { cwd: process.cwd(), listeners: new Set() };
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
  const s = state();
  if (s.cwd === target) return;
  s.cwd = target;
  for (const listener of s.listeners) listener();
}

export function onCwdChange(listener: () => void): () => void {
  const listeners = state().listeners;
  if (listeners.size >= 16) throw new Error("Cwd listener limit exceeded");
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
