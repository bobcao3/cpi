/**
 * Live session dir — single source of truth, mirroring `lib/cwd.ts`.
 *
 * pi exposes the session dir only via `ctx.sessionManager.getSessionDir()`
 * (a per-session snapshot). Pure-leaf modules (the LSP diagnostics-overflow
 * dumper, the editor/shell LSP hooks) need it to persist overflow dumps but
 * hold no `ctx` and must not import pi. This module mirrors the snapshot into
 * an importable value, populated by `core.ts` (sole owner of shared plumbing)
 * at `session_start` — the sanctioned `globalThis` shared-*state* pattern (data
 * re-read every call, NOT a boolean dedup flag).
 *
 * Invariant: `getSessionDir()` returns the dir set by the last `session_start`,
 * or `undefined` for ephemeral (`--no-session`) parents. Callers that need a
 * writable fallback (overflow logs) degrade to `os.tmpdir()` when it is
 * `undefined`, exactly like the `sh` tool's `/tmp/pi-sh-output-*.log` path.
 */

const STATE_KEY = "__cpiSessionDir";

/**
 * Current session dir (follows `session_start`), or `undefined` for ephemeral
 * parents. Never throws.
 */
export function getSessionDir(): string | undefined {
  const g = globalThis as Record<string, unknown>;
  const v = g[STATE_KEY];
  return typeof v === "string" ? v : undefined;
}

/**
 * Record the session dir. Called once per `session_start` by `core.ts`.
 * `undefined` (ephemeral parent) clears the slot so a stale dir never leaks
 * across sessions.
 */
export function setSessionDir(dir: string | undefined): void {
  const g = globalThis as Record<string, unknown>;
  if (dir === undefined) delete g[STATE_KEY];
  else g[STATE_KEY] = dir;
}
