#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const input = resolve(process.argv[2] ?? "");
assert(
  process.argv.length === 3,
  "Usage: node packages/cli/scripts/import-pi.mjs ARTIFACT_DIRECTORY",
);
const manifest = JSON.parse(
  await readFile(join(input, "manifest.json"), "utf8"),
);
assert.equal(manifest.format, 1);
assert.match(manifest.upstreamRevision, /^[a-f0-9]{40}$/);
assert.match(manifest.forkRevision, /^[a-f0-9]{40}$/);
assert.match(manifest.version, /^\d+\.\d+\.\d+-cpi\.\d+$/);
assert(manifest.artifacts.length > 0 && manifest.artifacts.length < 32);
const vendor = join(root, "vendor/pi");
await mkdir(vendor, { recursive: true });
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const cliPath = join(root, "packages/cli/package.json");
const cli = JSON.parse(await readFile(cliPath, "utf8"));
const names = new Set();
for (const artifact of manifest.artifacts) {
  assert(!names.has(artifact.name), `Duplicate artifact: ${artifact.name}`);
  names.add(artifact.name);
  assert(artifact.name.startsWith("@earendil-works/"));
  assert.equal(artifact.version, manifest.version);
  assert.equal(artifact.filename, `${artifact.sha256}.tgz`);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
  const bytes = await readFile(join(input, artifact.filename));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
  );
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    artifact.integrity,
  );
  try {
    assert.deepEqual(await readFile(join(vendor, artifact.filename)), bytes);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await copyFile(
      join(input, artifact.filename),
      join(vendor, artifact.filename),
    );
  }
  pkg.dependencies ??= {};
  pkg.overrides ??= {};
  pkg.dependencies[artifact.name] = `file:vendor/pi/${artifact.filename}`;
  pkg.overrides[artifact.name] = `$${artifact.name}`;
  cli.dependencies[artifact.name] = manifest.version;
}
for (const artifact of manifest.artifacts) {
  for (const name of Object.keys(artifact.dependencies)) {
    if (name.startsWith("@earendil-works/"))
      assert(names.has(name), `Incomplete fork closure: ${name}`);
  }
}
await writeFile(
  join(vendor, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
await writeFile(
  join(root, "package.json"),
  `${JSON.stringify(pkg, null, 2)}\n`,
);
await writeFile(cliPath, `${JSON.stringify(cli, null, 2)}\n`);
console.log(
  `Imported ${names.size} immutable Pi artifacts at ${manifest.version}; refresh the reviewed npm lock explicitly.`,
);
