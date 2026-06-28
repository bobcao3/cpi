/**
 * Per-path serialization for the editing tools (`edit`/`write`).
 *
 * The agent may fan editing tool calls out in parallel. Same-path writes must
 * not race: a later writer must not clobber an earlier write whose
 * SEARCH/REPLACE blocks were computed against now-stale content ("wrongfully
 * patch"). Different paths are independent and run in parallel.
 *
 * `withPathLock` is an in-process async mutex keyed by absolute path, stored on
 * `globalThis` so it survives jiti hot-reload — shared mutable state re-read on
 * every call (the endorsed pattern in AGENTS.md), NOT a boolean dedup flag
 * gating per-instance registration. Same-path calls execute FIFO; different
 * paths run in parallel. The whole mutation (read → subagent → apply → atomic
 * write) is held under the lock, so a later same-path edit re-reads the earlier
 * edit's result instead of racing it.
 *
 * This is the sole concurrency mechanism. Within one process it removes same-file
 * races entirely, so no compare-and-swap is needed; cross-process drift (a
 * concurrent `sh`/external edit during the subagent run) is out of scope for a
 * cross-platform extension. The atomic tmp+rename write in editor.ts guarantees
 * only that the file is never left half-written.
 *
 * Pure leaf: globalThis + Promises only.
 */

type LockMap = Map<string, Promise<unknown>>;

const LOCKS_KEY = "__cpiLlmEditorPathLocks";

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
  map.set(
    path,
    prevSafe.then(() => held),
  );
  await prevSafe;
  try {
    return await fn();
  } finally {
    release();
  }
}
