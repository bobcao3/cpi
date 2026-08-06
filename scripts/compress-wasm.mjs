#!/usr/bin/env node
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
console.log(
  `wrote ${path}.br (${compressed.length} bytes, ${Math.round((compressed.length / raw.length) * 100)}% of ${raw.length})`,
);
