import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
const excluded = new Set([
  "node_modules",
  "dist",
  "vendor",
  "generated",
  "licenses",
  "fonts",
  ".git",
  ".jj",
  ".zig-cache",
  "zig-pkg",
  "zig-out",
]);
const sourceExtensions = new Set([
  ".ts",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
]);

export function sourceFiles() {
  const files = [];
  const pending = [
    "scripts",
    "packages/cli",
    "packages/harness",
    "packages/ghostmux",
    "packages/tree-sitter-wasm",
  ];
  while (pending.length) {
    const directory = pending.pop();
    for (const entry of readdirSync(join(root, directory), {
      withFileTypes: true,
    })) {
      if (excluded.has(entry.name) || entry.name.endsWith(".generated.ts"))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (
        entry.isFile() &&
        sourceExtensions.has(extname(path)) &&
        !/\.d\.[cm]?ts$/.test(path)
      )
        files.push(path);
    }
  }
  return files.sort();
}
