/**
 * Project auto-discovery + language-by-path (pure node, design §6.1).
 *
 * `discoverProjectRoot(startPath, langHint?)` walks upward from the start
 * path's directory until it finds the nearest dir containing a project marker,
 * then returns that dir. Language-specific markers are checked before generic
 * ones at each level, and `langHint` (derived from the file extension) selects
 * which language's markers are "specific". Bounded: max depth 32, stops at
 * `HOME` or `/` (never roots a project at the user's home). A lone file with no
 * marker anywhere falls back to its own `dirname` so it still gets a session.
 *
 * No recursion; explicit depth cap; pure function (no pi import). `Language`
 * is defined here (the language-detection module) and re-used by registry.ts
 * so discover stays a leaf — registry imports it, not the reverse.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { resolveCwdPath } from "../cwd.ts";

/** Languages cpi provisions an LSP for (design §6.2). */
export type Language = "typescript" | "python" | "shell";

/** Ordered list, for deterministic iteration. */
export const LSP_LANGUAGES: readonly Language[] = ["typescript", "python", "shell"];

/** File extensions per language (lowercased, with dot). */
export const LANGUAGE_EXTENSIONS: Record<Language, string[]> = {
  typescript: [".ts", ".tsx"],
  python: [".py"],
  shell: [".sh", ".bash"],
};

/**
 * Project-root markers per language (design §6.1). Checked before generic
 * markers when a `langHint` is given. Shell's only marker is `.git`.
 */
export const LANGUAGE_MARKERS: Record<Language, string[]> = {
  typescript: ["tsconfig.json", "package.json", "jsconfig.json"],
  python: [
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "uv.lock",
    "requirements.txt",
    "Pipfile",
    ".python-version",
  ],
  shell: [".git"],
};

/** Generic markers, checked after the language-specific set. */
const GENERIC_MARKERS: string[] = [".git", ".hg"];

/** Upward-walk depth cap (design §6.1, §12 default). */
export const DISCOVERY_MAX_DEPTH = 32;

function hasMarker(dir: string, markers: readonly string[]): boolean {
  for (const m of markers) {
    if (existsSync(join(dir, m))) return true;
  }
  return false;
}

/**
 * Language for a file path by extension, or null when unrecognized.
 * `.ts`/`.tsx` → "typescript"; `.py` → "python"; `.sh`/`.bash` → "shell".
 * (The LSP `languageId` — `typescriptreact` for `.tsx` etc. — lives in
 * registry.ts; this returns only the coarse `Language`.)
 */
export function languageByPath(path: string): Language | null {
  if (typeof path !== "string" || path.length === 0) {
    throw new Error("languageByPath: path must be a non-empty string");
  }
  const ext = extname(path).toLowerCase();
  for (const lang of LSP_LANGUAGES) {
    if (LANGUAGE_EXTENSIONS[lang].includes(ext)) return lang;
  }
  return null;
}

/**
 * Walk upward from `startPath`'s directory to the nearest dir holding a
 * project marker. `langHint` biases which markers are "language-specific"
 * (checked first at each level); without a hint, all languages' markers are
 * considered. Stops at `HOME` / `/` (never returns home as a root) and after
 * {@link DISCOVERY_MAX_DEPTH} levels. If no marker is found, returns the
 * start path's own directory (lone-file fallback) so a session still gets a root.
 */
export function discoverProjectRoot(startPath: string, langHint?: Language): string {
  if (typeof startPath !== "string" || startPath.length === 0) {
    throw new Error("discoverProjectRoot: startPath must be a non-empty string");
  }
  const abs = resolveCwdPath(startPath);
  const isFile = existsSync(abs) && statSync(abs).isFile();
  const startDir = isFile ? dirname(abs) : abs;
  const langMarkers = langHint !== undefined ? LANGUAGE_MARKERS[langHint] : ALL_LANGUAGE_MARKERS;
  const home = process.env.HOME ?? "";

  let dir = startDir;
  for (let depth = 0; depth < DISCOVERY_MAX_DEPTH; depth++) {
    if (dir === "/" || dir === home) break;
    if (hasMarker(dir, langMarkers) || hasMarker(dir, GENERIC_MARKERS)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // reached fs root
    dir = parent;
  }
  return startDir;
}

/** Union of every language's markers (used when no `langHint` is given). */
const ALL_LANGUAGE_MARKERS: string[] = (() => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lang of LSP_LANGUAGES) {
    for (const m of LANGUAGE_MARKERS[lang]) {
      if (!seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
  }
  return out;
})();
