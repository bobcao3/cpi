/**
 * Live CWD — single source of truth for the agent's working directory.
 *
 * pi captures `_cwd` as a startup snapshot (sessionManager.getCwd()) and
 * exposes no API to mutate it. The cwd extension works around this by
 * `process.chdir()`-ing on set_cwd; the shell tool (spawn with no `cwd`
 * option) and every `process.cwd()` reader follows.
 *
 * This module mirrors that into an explicit, importable value so other
 * tools never reach for the stale `ctx.cwd` / `sessionManager.getCwd()`
 * snapshot or a bare `process.cwd()`.
 *
 * Invariants:
 *   - `getCwd()` returns the last directory applied via `setCwd()`, or the
 *     process cwd at first read.
 *   - `setCwd()` keeps the tracked value and `process.cwd()` in lockstep.
 */

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

/** Current working directory, following set_cwd. Never the stale snapshot. */
export function getCwd(): string {
  return state().cwd;
}

/**
 * Resolve `input` against the live cwd: absolute paths pass through,
 * relative paths resolve against `getCwd()`.
 */
export function resolveCwdPath(input: string): string {
  return isAbsolute(input) ? input : resolve(state().cwd, input);
}

/** Apply a new cwd: mutate process cwd and the tracked state together. */
export function setCwd(target: string): void {
  process.chdir(target);
  state().cwd = target;
}
