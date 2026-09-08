import { opendirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const MAX_FILES = 4096;
const MAX_SCAN = MAX_FILES * 2;

function activeTranscripts(): Set<string> {
  const state = globalThis as Record<string, unknown>;
  return (state.__cpiActiveTranscripts ??= new Set<string>()) as Set<string>;
}

export function reserveTranscript(base: string, directory: string): () => void {
  const active = activeTranscripts();
  const files: { path: string; base: string }[] = [];
  const listing = opendirSync(directory);
  try {
    for (let scanned = 0; scanned < MAX_SCAN; scanned++) {
      const entry = listing.readSync();
      if (!entry) break;
      if (
        !entry.isFile() ||
        !/^\d{13}-[A-Za-z0-9-]+\.(md|stderr)$/.test(entry.name)
      )
        continue;
      const path = join(directory, entry.name);
      files.push({ path, base: path.replace(/\.(md|stderr)$/, "") });
    }
  } finally {
    listing.closeSync();
  }
  let excess = files.length + 2 - MAX_FILES;
  if (excess > 0) {
    const candidates = files
      .filter((file) => !active.has(file.base))
      .sort((a, b) => a.base.localeCompare(b.base));
    let previous = "";
    for (const file of candidates) {
      if (excess <= 0 && file.base !== previous) break;
      previous = file.base;
      try {
        unlinkSync(file.path);
        excess--;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  active.add(base);
  return () => active.delete(base);
}
