/**
 * Project auto-discovery + language-by-path (pure node). Walks upward at most
 * DISCOVERY_MAX_DEPTH levels, stops before HOME and /, and falls back to the
 * starting directory.
 */

import { existsSync, statSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { resolveCwdPath } from "../cwd.ts";

export type Language = "typescript" | "python" | "shell" | "ruby";

export const LSP_LANGUAGES: readonly Language[] = [
  "typescript",
  "python",
  "shell",
  "ruby",
];

export const LANGUAGE_EXTENSIONS: Record<Language, string[]> = {
  typescript: [".ts", ".tsx"],
  python: [".py"],
  shell: [".sh", ".bash", ".zsh", ".mksh", ".ksh", ".dash", ".ash", ".bats"],
  ruby: [".rb", ".rake"],
};

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
  ruby: ["Gemfile", "Gemfile.lock", ".ruby-version", "Rakefile"],
};

const GENERIC_MARKERS: string[] = [".git", ".hg"];

export const DISCOVERY_MAX_DEPTH = 32;

function hasMarker(dir: string, markers: readonly string[]): boolean {
  for (const m of markers) {
    if (existsSync(join(dir, m))) return true;
  }
  return false;
}

/** Extension→Language; registry.ts supplies the LSP languageId. */
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

export function discoverProjectRoot(
  startPath: string,
  langHint?: Language,
): string {
  if (typeof startPath !== "string" || startPath.length === 0) {
    throw new Error(
      "discoverProjectRoot: startPath must be a non-empty string",
    );
  }
  const abs = resolveCwdPath(startPath);
  const isFile = existsSync(abs) && statSync(abs).isFile();
  const startDir = isFile ? dirname(abs) : abs;
  const langMarkers =
    langHint !== undefined ? LANGUAGE_MARKERS[langHint] : ALL_LANGUAGE_MARKERS;
  const home = process.env.HOME ?? "";

  let dir = startDir;
  for (let depth = 0; depth < DISCOVERY_MAX_DEPTH; depth++) {
    if (dir === "/" || dir === home) break;
    if (hasMarker(dir, langMarkers) || hasMarker(dir, GENERIC_MARKERS))
      return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

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
