/** Resume-socket dir for sh-monitor (hot path is pipes; sh_detach is nohup). Priority: XDG_RUNTIME_DIR/pi, PI_SESSION_DIR/sh-mon, HOME/.pi/runtime — env is forgeable, so roots are ownership-asserted, forced 0700. */
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { platform } from "node:os";

const IS_WIN = platform() === "win32";
const MODE_PRIVATE = 0o700;

export function resolveRuntimeDir(env: NodeJS.ProcessEnv): string | null {
  if (IS_WIN) return null;
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  const candidates: Array<{ root: string; dir: string }> = [];
  if (env.XDG_RUNTIME_DIR)
    candidates.push({
      root: env.XDG_RUNTIME_DIR,
      dir: join(env.XDG_RUNTIME_DIR, "pi"),
    });
  if (env.PI_SESSION_DIR)
    candidates.push({
      root: env.PI_SESSION_DIR,
      dir: join(env.PI_SESSION_DIR, "sh-mon"),
    });
  if (env.HOME)
    candidates.push({ root: env.HOME, dir: join(env.HOME, ".pi", "runtime") });
  for (const c of candidates) {
    const dir = ensurePrivateDir(c.root, c.dir, uid);
    if (dir) return dir;
  }
  return null;
}

export function resolveRuntimePath(
  env: NodeJS.ProcessEnv,
  childPid: number,
): string | null {
  if (
    !Number.isSafeInteger(childPid) ||
    childPid <= 0 ||
    !Number.isSafeInteger(process.pid) ||
    process.pid <= 0
  )
    return null;
  if (IS_WIN)
    return `\\\\.\\pipe\\cpi-sh-mon-${process.pid}-${childPid}-${randomBytes(16).toString("hex")}`;
  const dir = resolveRuntimeDir(env);
  return dir ? join(dir, `pi-sh-mon-${childPid}.sock`) : null;
}

function ensurePrivateDir(
  root: string,
  dir: string,
  uid: number | undefined,
): string | null {
  try {
    if (uid !== undefined && statSync(root).uid !== uid) return null;
    mkdirSync(dir, { recursive: true, mode: MODE_PRIVATE });
    chmodSync(dir, MODE_PRIVATE); // mkdir mode is masked by umask; force it
    if (uid !== undefined && statSync(dir).uid !== uid) return null;
    return dir;
  } catch {
    return null;
  }
}
