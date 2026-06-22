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

/** Content-addressed media dir for one project: <state>/projects/<id>/media.
 *  Blobs are stored by their SHA-256 hex (content_hash); see
 *  docs/data_model/PROJECT.md. */
export function mediaDir(projectId: string): string {
  return path.join(projectDir(projectId), "media");
}

/** Path to one content-addressed blob: <state>/projects/<id>/media/<hash>. */
export function mediaPath(projectId: string, contentHash: string): string {
  return path.join(mediaDir(projectId), contentHash);
}
