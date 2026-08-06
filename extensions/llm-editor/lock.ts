type LockMap = Map<string, Promise<unknown>>;

const LOCKS_KEY = "__cpiLlmEditorPathLocks";

/** GlobalThis so the lock map survives jiti hot-reload (shared state, not a dedup flag). */
function lockMap(): LockMap {
  const g = globalThis as Record<string, unknown>;
  let m = g[LOCKS_KEY] as LockMap | undefined;
  if (!m) {
    m = new Map();
    g[LOCKS_KEY] = m;
  }
  return m;
}

/** Per-path mutex: same-path calls serialize so a later write never clobbers an earlier one whose hunks were computed against stale content. */
export async function withPathLock<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
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
