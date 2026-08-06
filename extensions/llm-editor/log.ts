/** Viewer/Editor calls are ephemeral (--no-session): the streamed transcript is persisted here, rotated by mtime past the cap. */

import { mkdir, writeFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "cpi-editor");

export function resolveTranscriptDir(configured: string, cwd: string): string {
  if (!configured) return DEFAULT_DIR;
  let p = configured;
  if (p.startsWith("~")) p = join(homedir(), p.slice(1));
  if (!p.startsWith("/")) p = join(cwd, p);
  return p;
}

/** Best-effort: a write failure returns the intended path, never throws; content-addressed by id, so re-running the same args overwrites the same slot. */
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
  await Promise.all(
    remove.map((e) => unlink(join(dir, e.name)).catch(() => {})),
  );
}
