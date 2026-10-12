import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { releaseInput } from "./sync-pi-release-input.mjs";
import {
  fetchBytes,
  githubJson,
  publishedRelease,
  releaseAsset,
  releaseBase,
  resolveTag,
  sourceRepository,
  validateArchive,
  validateManifest,
  validatePackage,
  validateReport,
} from "./sync-pi-release-validation.mjs";

assert.equal(
  process.argv.length,
  4,
  "Usage: sync-pi-release.mjs RELEASE_TAG NEW_DIRECTORY",
);
const input = releaseInput(process.argv[2]);
const directory = resolve(process.argv[3]);
const mib = 1024 * 1024;
const apiPath = `/repos/${sourceRepository}/releases/tags/${input.tag}`;
const release = await githubJson(apiPath);
const assets = publishedRelease(release, input.tag);
const revision = await resolveTag(input.tag);
const origins = [
  "https://github.com",
  "https://release-assets.githubusercontent.com",
  "https://objects.githubusercontent.com",
];
let total = 0;
async function download(filename, limit) {
  const asset = releaseAsset(assets, input.tag, filename, limit);
  assert(
    (total += asset.size) <= 512 * mib,
    "Release downloads exceed the total size limit",
  );
  const bytes = await fetchBytes(asset.browser_download_url, limit, origins);
  assert.equal(bytes.length, asset.size, "Release asset size mismatch");
  return bytes;
}
const manifestBytes = await download("manifest.json", mib);
const manifest = JSON.parse(manifestBytes);
const current = JSON.parse(
  await readFile(new URL("../../../vendor/pi/manifest.json", import.meta.url)),
);
const { names, archives } = validateManifest(
  manifest,
  input,
  revision,
  current.artifacts.map((artifact) => artifact.name),
);
const reportBytes = await download("verification.json", mib);
validateReport(JSON.parse(reportBytes), manifest);
await mkdir(directory);
const checked = new Map();
for (const [hash, artifact] of archives) {
  const bytes = await download(`${hash}.tgz`, 64 * mib);
  checked.set(hash, await validateArchive(bytes, artifact));
  await writeFile(join(directory, `${hash}.tgz`), bytes, { flag: "wx" });
}
for (const artifact of names.values()) {
  const archive = checked.get(artifact.sha256);
  validatePackage(archive, artifact, manifest, names);
  if (artifact.source) {
    const source = checked.get(artifact.source.sha256);
    validatePackage(source, artifact, manifest, names, true);
    assert.deepEqual(
      archive.payload,
      source.payload,
      "Closed archive changes the source payload",
    );
  }
}
assert.equal(
  await resolveTag(input.tag),
  revision,
  "Release tag moved during verification",
);
const finalRelease = await githubJson(apiPath);
publishedRelease(finalRelease, input.tag);
assert.equal(
  finalRelease.id,
  release.id,
  "Release changed during verification",
);
await writeFile(join(directory, "manifest.json"), manifestBytes, {
  flag: "wx",
});
await writeFile(join(directory, "verification.json"), reportBytes, {
  flag: "wx",
});
console.log(
  `Verified ${manifest.version} at ${revision}: ${releaseBase(input.tag)}`,
);
