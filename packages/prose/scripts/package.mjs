import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";
import { init } from "es-module-lexer";
import { stage_wasm } from "../../tree-sitter-wasm/scripts/package-api.mjs";
import { releaseTag, verifyArtifact } from "../../tree-sitter-wasm/resolve.ts";
import {
  registry_manifest,
  registry_repository,
} from "../../cli/scripts/registry-manifest.mjs";
import { stage_workspace } from "../../cli/scripts/registry-stage.mjs";
import {
  digest,
  execute,
  integrity,
  json,
  release_tag,
  validate,
} from "./release.mjs";

assert.equal(process.argv.length, 3, "Usage: package.mjs NEW_OUTPUT_DIRECTORY");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const output = resolve(process.argv[2]);
const prose = await json(join(root, "packages/prose/package.json"));
const wasm = await json(join(root, "packages/tree-sitter-wasm/package.json"));
assert.equal(prose.version, wasm.version);
assert.deepEqual(prose.dependencies, { "@cpi/tree-sitter-wasm": wasm.version });
const tag = release_tag(prose.version);
const revision = (
  await execute("git", ["rev-parse", "HEAD"], { cwd: root })
).trim();
assert.match(revision, /^[a-f0-9]{40}$/);
if (process.env.GITHUB_ACTIONS === "true")
  assert.equal(revision, process.env.GITHUB_SHA);
const source = { repository: registry_repository, revision, tag };
await mkdir(output, { recursive: false });
const staging = join(output, ".stage");
await mkdir(staging);
async function download(name) {
  const response = await fetch(
    `https://github.com/bobcao3/cpi/releases/download/${releaseTag}/${name}`,
    { signal: AbortSignal.timeout(120000) },
  );
  assert(response.ok, `${name}: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    assert(
      (size += chunk.length) < 128 * 1024 * 1024,
      "WASM download exceeds its size limit",
    );
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
try {
  const [compressed, signature] = await Promise.all([
    download("tree-sitter-wasm.wasm.br"),
    download("tree-sitter-wasm.wasm.minisig"),
  ]);
  const bytes = brotliDecompressSync(compressed, {
    maxOutputLength: 128 * 1024 * 1024,
  });
  verifyArtifact(bytes, signature.toString());
  const artifact = join(staging, "tree-sitter-wasm.wasm");
  await writeFile(artifact, bytes);
  await writeFile(`${artifact}.minisig`, signature);
  await init;
  const versions = new Map([
    [wasm.name, wasm.version],
    [prose.name, prose.version],
  ]);
  const entries = [
    [
      join(staging, "tree-sitter-wasm"),
      await stage_wasm(join(staging, "tree-sitter-wasm"), artifact),
    ],
    [
      join(staging, "prose"),
      await stage_workspace(root, "packages/prose", join(staging, "prose")),
    ],
  ];
  const packages = [];
  for (const [directory, original] of entries) {
    const manifest = registry_manifest(original, versions);
    if (manifest.bin?.["cpi-prose"])
      manifest.bin["cpi-prose"] = "bin/cpi-prose.mjs";
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const [packed] = Object.values(
      JSON.parse(
        await execute(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
          { cwd: directory },
        ),
      ),
    );
    assert.match(packed.filename, /^[\w.-]+\.tgz$/);
    const archive = await readFile(join(output, packed.filename));
    assert.equal(packed.integrity, integrity(archive));
    packages.push({
      name: manifest.name,
      version: manifest.version,
      filename: packed.filename,
      sha256: digest(archive),
      integrity: integrity(archive),
      source,
    });
  }
  await writeFile(
    join(output, "packages.json"),
    `${JSON.stringify(packages, null, 2)}\n`,
  );
  await writeFile(
    join(output, "SHA256SUMS"),
    packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}\n`).join(""),
  );
  await validate(output);
  console.log(`Prepared signed WASM and prose registry packages: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
