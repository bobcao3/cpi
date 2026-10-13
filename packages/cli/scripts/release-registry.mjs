import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry_release_version } from "./registry-version.mjs";

const repository = "bobcao3/cpi";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function release_assets(directory, tag) {
  const version = registry_release_version(tag);
  assert(version, "A release requires a version tag");
  const metadata = await readFile(join(directory, "packages.json"));
  assert(metadata.length < 1024 * 1024);
  const packages = JSON.parse(metadata);
  assert(packages.length > 0 && packages.length < 32);
  assert.equal(packages.at(-1).name, "@bobcao3/cpi");
  const names = new Set();
  const files = ["packages.json", "SHA256SUMS", "fork-provenance.json"];
  let expected_checksums = "";
  for (const pkg of packages) {
    assert(pkg.name.startsWith("@bobcao3/"));
    assert(!names.has(pkg.name), `Duplicate package: ${pkg.name}`);
    names.add(pkg.name);
    assert(/^[\w.-]+\.tgz$/.test(pkg.filename));
    if (pkg.name === "@bobcao3/cpi" || pkg.name.startsWith("@bobcao3/cpi-"))
      assert.equal(
        pkg.version,
        version,
        `Version disagrees with tag: ${pkg.name}`,
      );
    assert(
      (await stat(join(directory, pkg.filename))).size <= 64 * 1024 * 1024,
    );
    const bytes = await readFile(join(directory, pkg.filename));
    assert.equal(digest(bytes), pkg.sha256);
    assert.equal(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      pkg.integrity,
    );
    files.push(pkg.filename);
    expected_checksums += `${pkg.sha256}  ${pkg.filename}\n`;
  }
  assert.equal(
    await readFile(join(directory, "SHA256SUMS"), "utf8"),
    expected_checksums,
  );
  assert.equal(new Set(files).size, files.length);
  const assets = [];
  let total = 0;
  for (const name of files) {
    const size = (await stat(join(directory, name))).size;
    assert(size <= 64 * 1024 * 1024 && (total += size) <= 512 * 1024 * 1024);
    const bytes = await readFile(join(directory, name));
    assets.push({ name, size, sha256: digest(bytes) });
  }
  return assets;
}

function gh(args, missing = false) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 128 * 1024 * 1024,
  });
  assert.ifError(result.error);
  if (missing && result.status !== 0 && /HTTP 404/.test(result.stderr))
    return undefined;
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

export function verify_release_tag() {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Publish through GitHub Actions",
  );
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF_TYPE, "tag");
  const tag = process.env.GITHUB_REF_NAME;
  assert(tag, "Release tag is unavailable");
  const revision = process.env.GITHUB_SHA;
  assert.match(revision, /^[a-f0-9]{40}$/);
  let object = JSON.parse(
    gh(["api", `repos/${repository}/git/ref/tags/${tag}`]),
  ).object;
  for (let count = 0; object.type === "tag" && count < 8; count++)
    object = JSON.parse(
      gh(["api", `repos/${repository}/git/tags/${object.sha}`]),
    ).object;
  assert.equal(object.type, "commit", "Tag nesting exceeds its limit");
  assert.equal(object.sha, revision, "Tag moved after verification");
  return tag;
}

async function publish(directory) {
  const tag = verify_release_tag();
  const assets = await release_assets(directory, tag);
  const endpoint = `repos/${repository}/releases/tags/${tag}`;
  let response = gh(["api", endpoint], true);
  if (!response) {
    gh([
      "release",
      "create",
      tag,
      "--repo",
      repository,
      "--verify-tag",
      "--draft",
      "--title",
      `cpi ${registry_release_version(tag)}`,
      "--generate-notes",
    ]);
    response = gh(["api", endpoint]);
  }
  const release = JSON.parse(response);
  assert.equal(release.tag_name, tag);
  assert(release.assets.length <= 100);
  for (const asset of assets) {
    const existing = release.assets.find((entry) => entry.name === asset.name);
    if (existing) {
      assert.equal(
        existing.size,
        asset.size,
        `Existing asset differs: ${asset.name}`,
      );
      const result = spawnSync(
        "gh",
        [
          "api",
          `repos/${repository}/releases/assets/${existing.id}`,
          "-H",
          "Accept: application/octet-stream",
        ],
        {
          timeout: 120000,
          maxBuffer: 64 * 1024 * 1024 + 1,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr.toString());
      assert.equal(
        digest(result.stdout),
        asset.sha256,
        `Existing asset differs: ${asset.name}`,
      );
    } else {
      gh([
        "release",
        "upload",
        tag,
        join(directory, asset.name),
        "--repo",
        repository,
      ]);
    }
  }
  if (release.draft)
    gh([
      "release",
      "edit",
      tag,
      "--repo",
      repository,
      "--draft=false",
      "--latest",
    ]);
  for (const asset of assets) {
    const download = await fetch(
      `https://github.com/${repository}/releases/download/${tag}/${asset.name}`,
      { signal: AbortSignal.timeout(120000) },
    );
    assert(download.ok, `${asset.name}: HTTP ${download.status}`);
    const hash = createHash("sha256");
    let size = 0;
    for await (const bytes of download.body) {
      assert((size += bytes.length) <= asset.size);
      hash.update(bytes);
    }
    assert.equal(size, asset.size);
    assert.equal(
      hash.digest("hex"),
      asset.sha256,
      `Public asset differs: ${asset.name}`,
    );
  }
  console.log(`Verified https://github.com/${repository}/releases/tag/${tag}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  assert.equal(
    process.argv.length,
    3,
    "Usage: release-registry.mjs VERIFIED_PACKAGE_DIRECTORY",
  );
  await publish(resolve(process.argv[2]));
}
