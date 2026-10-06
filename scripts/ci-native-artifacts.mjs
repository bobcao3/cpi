import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import {
  artifactName,
  platformKey,
  platforms,
  releaseTag as ghostmux_tag,
  sourceDigest,
} from "@cpi/ghostmux/source";
import { verifyArtifact as verify_ghostmux } from "@cpi/ghostmux/signature";
import {
  releaseTag as wasm_tag,
  verifyArtifact as verify_wasm,
} from "@cpi/tree-sitter-wasm/resolve";

assert(
  process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === "--all"),
  "Usage: node scripts/ci-native-artifacts.mjs NEW_DIRECTORY [--all]",
);
const directory = resolve(process.argv[2]);
await mkdir(directory);
async function download(tag, name) {
  const response = await fetch(
    `https://github.com/bobcao3/cpi/releases/download/${tag}/${name}`,
    {
      signal: AbortSignal.timeout(120000),
    },
  );
  assert(response.ok, `${name}: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 128 * 1024 * 1024, "Native artifact exceeds the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
const [compressed, wasm_signature] = await Promise.all([
  download(wasm_tag, "tree-sitter-wasm.wasm.br"),
  download(wasm_tag, "tree-sitter-wasm.wasm.minisig"),
]);
const wasm = brotliDecompressSync(compressed, {
  maxOutputLength: 128 * 1024 * 1024,
});
verify_wasm(wasm, wasm_signature.toString());
for (const [filename, bytes] of [
  ["tree-sitter-wasm.wasm", wasm],
  ["tree-sitter-wasm.wasm.minisig", wasm_signature],
])
  await writeFile(join(directory, filename), bytes);
const source_sha256 = await sourceDigest();
for (const platform of process.argv[3] === "--all"
  ? Object.keys(platforms)
  : [platformKey()]) {
  const name = artifactName(platform);
  const [binary, signature] = await Promise.all([
    download(ghostmux_tag, name),
    download(ghostmux_tag, `${name}.minisig`),
  ]);
  verify_ghostmux(binary, signature.toString(), source_sha256, platform);
  await writeFile(join(directory, name), binary, { mode: 0o755 });
  await writeFile(join(directory, `${name}.minisig`), signature);
  await chmod(join(directory, name), 0o755);
}
console.log(
  "Verified signed native CI inputs against the checkout's trust anchors.",
);
