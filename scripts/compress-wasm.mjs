#!/usr/bin/env node
/**
 * Brotli-compress a file (used by CI to shrink the tree-sitter wasm release
 * asset). Writes <path>.br next to the input.
 *
 * Zero deps (node:zlib). Decompression on the client side is
 * zlib.brotliDecompressSync (available since Node 11.7; pi requires >=22.19).
 *
 * Usage: node scripts/compress-wasm.mjs <path-to-wasm>
 */
import * as zlib from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const [path] = process.argv.slice(2);
if (!path) {
  console.error("usage: node scripts/compress-wasm.mjs <wasm-file>");
  process.exit(1);
}

const raw = readFileSync(path);
const compressed = zlib.brotliCompressSync(raw, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
writeFileSync(path + ".br", compressed);
console.log(`wrote ${path}.br (${compressed.length} bytes, ${Math.round((compressed.length / raw.length) * 100)}% of ${raw.length})`);
