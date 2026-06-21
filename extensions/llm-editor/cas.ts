/**
 * Per-path write serialization + compare-and-swap fingerprint.
 *
 * `llm_editor` `edit`/`create` are fanned out in parallel by the agent. Two
 * writes to the same path must not race: a late writer must not clobber an
 * earlier write whose SEARCH/REPLACE blocks were computed against now-stale
 * content ("wrongfully patch").
 *
 * - `withPathLock`: in-process async mutex keyed by absolute path. Stored on
 *   `globalThis` so it survives jiti hot-reload — this is shared mutable state
 *   re-read on every call (the endorsed pattern in AGENTS.md), NOT a boolean
 *   dedup flag gating per-instance registration. Same-path calls execute FIFO;
 *   different paths run in parallel. The subagent run is held under the lock so
 *   a later same-path edit re-reads the earlier edit's result instead of
 *   racing it.
 * - `Fingerprint`: { mtimeNs, size } captured at read time. `unchangedSince`
 *   re-stats at write time and refuses to patch if the file drifted (a concurrent
 *   `sh`/external edit during the subagent run). The per-path lock already
 *   removes in-process races, so the CAS only has to catch external drift;
 *   mtimeNs+size is the conventional "file changed?" CAS (every content write
 *   bumps mtime on ext4/btrfs/apfs).
 *
 * Residual TOCTOU (re-stat → rename) is microsecond-scale vs the multi-second
 * subagent window it replaces; closing it fully needs OS file locking, out of
 * scope for a cross-platform extension.
 *
 * Pure leaf: node:fs/promises only.
 */

import { stat } from "node:fs/promises";

const LOCKS_KEY = "__cpiLlmEditorPathLocks";
type LockMap = Map<string, Promise<unknown>>;

/** Global, reload-surviving map of per-path lock chains. Re-read every call. */
function lockMap(): LockMap {
  const g = globalThis as Record<string, unknown>;
  let m = g[LOCKS_KEY] as LockMap | undefined;
  if (!m) {
    m = new Map();
    g[LOCKS_KEY] = m;
  }
  return m;
}

/**
 * Run `fn` while holding the per-path mutex. Same-path calls execute
 * sequentially (FIFO by acquisition order); different paths run in parallel.
 * Non-reentrant: `fn` must not re-enter the same path. A throw or abort in `fn`
 * still releases the lock (finally), so it cannot be held forever.
 */
export async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const map = lockMap();
  const prev = map.get(path);
  const prevSafe = prev ? prev.catch(() => undefined) : Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  map.set(path, prevSafe.then(() => held));
  await prevSafe;
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface Fingerprint {
  mtimeNs: bigint;
  size: bigint;
}

/** Capture a file's identity at read time for later compare-and-swap. */
export function fingerprintOf(s: { mtimeNs: bigint; size: bigint }): Fingerprint {
  return { mtimeNs: s.mtimeNs, size: s.size };
}

function equal(a: Fingerprint, b: Fingerprint): boolean {
  return a.mtimeNs === b.mtimeNs && a.size === b.size;
}

/**
 * Compare-and-swap before patching: re-stat `path` and return true only if it
 * still matches the fingerprint captured at read time. Returns false on any stat
 * failure (file deleted/moved) or mismatch — callers must NOT write when this
 * returns false.
 */
export async function unchangedSince(path: string, at: Fingerprint): Promise<boolean> {
  try {
    const now = await stat(path, { bigint: true });
    return equal(at, fingerprintOf(now));
  } catch {
    return false;
  }
}
