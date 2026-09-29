import { chmodSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function resolveRuntimeDir(env: NodeJS.ProcessEnv): string | null {
  if (process.platform === "win32") return null;
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
      dir: join(env.PI_SESSION_DIR, "runtime"),
    });
  if (env.HOME)
    candidates.push({ root: env.HOME, dir: join(env.HOME, ".pi", "runtime") });
  for (const { root, dir } of candidates) {
    try {
      if (uid !== undefined && statSync(root).uid !== uid) continue;
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      chmodSync(dir, 0o700);
      if (uid !== undefined && statSync(dir).uid !== uid) continue;
      return dir;
    } catch {}
  }
  return null;
}
