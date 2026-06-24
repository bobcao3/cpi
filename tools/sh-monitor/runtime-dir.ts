/**
 * Per-user runtime directory for sh-monitor *resume* sockets.
 *
 * Resolved identically on the pi side and the sh-monitor side so a
 * resumed pi can find the socket a still-living supervisor bound. Pure: only
 * node: builtins, no pi imports — importable from both process types.
 *
 * The default hot path does NOT use this — pi talks to sh-monitor over the
 * spawned stdin/stdout pipes (no FS). This dir is only for the best-effort
 * resume socket bound when a shell is backgrounded (so a restarted pi can
 * re-attach). Detached shells (sh_detach) skip it entirely — they are nohup.
 *
 * Priority (first owned-by-us and usable):
 *   1. $XDG_RUNTIME_DIR/pi      — Linux per-user tmpfs: local (not NFS), 0700,
 *                                  cleaned at logout. AF_UNIX works reliably.
 *   2. $PI_SESSION_DIR/sh-mon   — pi's session folder (always exists). May be
 *                                  on a networked FS on clusters; resume is
 *                                  best-effort there (bind failure → no resume
 *                                  for that shell, never fatal).
 *   3. $HOME/.pi/runtime        — last resort, always exists.
 *
 * Env is forgeable, so each candidate's root is asserted to be owned by the
 * current uid before use; a private 0700 subdir is created and re-asserted.
 * Returns null only if nothing is usable — resume is then unavailable for that
 * shell (non-fatal; the pipe hot path still works).
 */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:os";

const IS_WIN = platform() === "win32";
const MODE_PRIVATE = 0o700;

export function resolveRuntimeDir(env: NodeJS.ProcessEnv): string | null {
  if (IS_WIN) return null; // AF_UNIX resume sockets unsupported on Windows
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const candidates: Array<{ root: string; dir: string }> = [];
  if (env.XDG_RUNTIME_DIR) candidates.push({ root: env.XDG_RUNTIME_DIR, dir: join(env.XDG_RUNTIME_DIR, "pi") });
  if (env.PI_SESSION_DIR) candidates.push({ root: env.PI_SESSION_DIR, dir: join(env.PI_SESSION_DIR, "sh-mon") });
  if (env.HOME) candidates.push({ root: env.HOME, dir: join(env.HOME, ".pi", "runtime") });
  for (const c of candidates) {
    const dir = ensurePrivateDir(c.root, c.dir, uid);
    if (dir) return dir;
  }
  return null;
}

/** Assert root is owned by uid, mkdir -p dir, force 0700, re-assert ownership. */
function ensurePrivateDir(root: string, dir: string, uid: number | undefined): string | null {
  try {
    if (uid !== undefined && statSync(root).uid !== uid) return null; // forged/foreign root
    mkdirSync(dir, { recursive: true, mode: MODE_PRIVATE });
    chmodSync(dir, MODE_PRIVATE); // mkdir mode is masked by umask; force it
    if (uid !== undefined && statSync(dir).uid !== uid) return null; // lost ownership (root mount)
    return dir;
  } catch {
    return null;
  }
}
