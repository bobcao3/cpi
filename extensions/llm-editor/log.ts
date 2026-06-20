/**
 * Subagent transcript persistence + rotation.
 *
 * Each Viewer/Editor call is ephemeral (--no-session: nothing saved by pi),
 * but the live markdown transcript streamed by the cpi subagent-transcript
 * extension (captured from the child's stderr) is written here for debugging
 * and visibility. Files live under a dedicated dir (default
 * ~/.pi/agent/cpi-editor), rotated by mtime when the count exceeds the cap.
 *
 * Pure leaf module: no pi/tui imports.
 */

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "cpi-editor");

/** Resolve a configured transcript dir (expand ~, absolute-ize against cwd). */
export function resolveTranscriptDir(configured: string, cwd: string): string {
  if (!configured) return DEFAULT_DIR;
  let p = configured;
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  if (!p.startsWith("/")) p = join(cwd, p);
  return p;
}

/**
 * Persist a transcript. Returns the absolute path written. Best-effort: a
 * write failure never breaks the tool (returns the intended path + logs).
 * The file is content-addressed by `id` (hex-safe), so re-running the same
 * args overwrites the same slot rather than creating a new timestamped file.
 */
export async function writeTranscript(
  dir: string,
  id: string,
  body: string,
  maxFiles: number,
): Promise<string> {
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    return dir;
  }
  const path = join(dir, `${id}.md`);
  try {
    await writeFile(path, body, "utf-8");
  } catch {
    return path;
  }
  await rotate(dir, maxFiles).catch(() => {});
  return path;
}

/** Delete oldest files until count <= maxFiles. */
async function rotate(dir: string, maxFiles: number): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  if (entries.length <= maxFiles) return;
  const statted = await Promise.all(
    entries.map(async (name) => {
      try {
        return { name, mtime: (await stat(join(dir, name))).mtimeMs };
      } catch {
        return { name, mtime: 0 };
      }
    }),
  );
  statted.sort((a, b) => a.mtime - b.mtime);
  const remove = statted.slice(0, statted.length - maxFiles);
  await Promise.all(remove.map((e) => unlink(join(dir, e.name)).catch(() => {})));
}
