import path from "node:path";
import { homedir } from "node:os";

/** Root state dir for tuidos. TUIDOS_STATE_DIR overrides the whole dir (for tests). */
export function tuidosDir(): string {
  const override = process.env.TUIDOS_STATE_DIR;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg ?? path.join(homedir(), ".local", "state");
  return path.join(base, "tuidos");
}

export function globalDbPath(): string {
  return path.join(tuidosDir(), "global.sqlite");
}

export function projectDir(id: string): string {
  return path.join(tuidosDir(), "projects", id);
}

export function projectDbPath(id: string): string {
  return path.join(projectDir(id), "state.sqlite");
}
