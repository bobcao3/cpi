import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { list } from "tar";

export const sourceRepository = "bobcao3/pi";
const mib = 1024 * 1024;
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;
const packageName = /^@earendil-works\/[a-z][a-z0-9-]{0,80}$/;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const releaseBase = (tag) =>
  `https://github.com/${sourceRepository}/releases/download/${tag}/`;

export async function fetchBytes(
  url,
  limit,
  origins,
  headers = {},
  timeout = 90000,
) {
  const signal = AbortSignal.timeout(timeout);
  for (let redirect = 0; redirect <= 4; redirect++) {
    assert(
      origins.includes(new URL(url).origin),
      "Download origin is not permitted",
    );
    const response = await fetch(url, { headers, signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      assert(redirect < 4, "Download redirect limit exceeded");
      assert(response.headers.get("location"), "Redirect has no location");
      url = new URL(response.headers.get("location"), url).href;
      headers = {};
      continue;
    }
    assert(
      response.ok,
      `Download failed: ${response.status} ${new URL(url).pathname}`,
    );
    const length = response.headers.get("content-length");
    if (length)
      assert(Number(length) <= limit, "Download exceeds the size limit");
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        assert(size <= limit, "Download exceeds the size limit");
        chunks.push(chunk);
      }
    } catch (error) {
      await response.body?.cancel().catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Download redirect limit exceeded");
}

export async function githubJson(path) {
  assert(path.startsWith(`/repos/${sourceRepository}/`));
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GH_TOKEN)
    headers.Authorization = `Bearer ${process.env.GH_TOKEN}`;
  return JSON.parse(
    await fetchBytes(
      `https://api.github.com${path}`,
      mib,
      ["https://api.github.com"],
      headers,
      30000,
    ),
  );
}

export async function resolveTag(tag) {
  let object = (
    await githubJson(`/repos/${sourceRepository}/git/ref/tags/${tag}`)
  ).object;
  for (let depth = 0; depth < 8; depth++) {
    assert.match(object?.sha ?? "", sha);
    if (object.type === "commit") {
      const commit = await githubJson(
        `/repos/${sourceRepository}/git/commits/${object.sha}`,
      );
      assert.equal(commit.sha, object.sha);
      return object.sha;
    }
    assert.equal(object.type, "tag", "Release tag must resolve to a commit");
    const annotated = await githubJson(
      `/repos/${sourceRepository}/git/tags/${object.sha}`,
    );
    assert.equal(annotated.sha, object.sha);
    object = annotated.object;
  }
  throw new Error("Annotated tag depth exceeds the limit");
}

export function publishedRelease(release, tag) {
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false, "Release must not be a draft");
  assert(
    Number.isFinite(Date.parse(release.published_at)),
    "Release must be published",
  );
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  assert(Array.isArray(release.assets) && release.assets.length <= 100);
  const assets = new Map();
  for (const asset of release.assets) {
    assert(!assets.has(asset.name), "Release asset names must be unique");
    assets.set(asset.name, asset);
  }
  return assets;
}

export function releaseAsset(assets, tag, filename, limit) {
  const asset = assets.get(filename);
  assert(asset, `Missing release asset: ${filename}`);
  assert.equal(asset.state, "uploaded");
  assert.equal(asset.browser_download_url, `${releaseBase(tag)}${filename}`);
  assert(
    Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= limit,
    "Release asset exceeds the size limit",
  );
  return asset;
}

export function validateManifest(manifest, input, revision, required) {
  assert.equal(manifest.format, 1);
  assert.equal(
    manifest.version,
    input.version,
    "Manifest version does not match the release tag",
  );
  assert.equal(
    manifest.forkRevision,
    revision,
    "Manifest revision does not match the resolved tag commit",
  );
  assert.match(manifest.upstreamRevision, sha);
  assert.match(manifest.upstreamVersion, stableVersion);
  assert(
    manifest.upstreamPackages &&
      typeof manifest.upstreamPackages === "object" &&
      !Array.isArray(manifest.upstreamPackages),
  );
  const upstream = Object.entries(manifest.upstreamPackages);
  assert(upstream.length <= 31);
  for (const [name, version] of upstream) {
    assert.match(name, packageName);
    assert.match(version, stableVersion);
  }
  assert(
    Array.isArray(manifest.artifacts) &&
      manifest.artifacts.length > 0 &&
      manifest.artifacts.length < 32,
  );
  const names = new Map();
  const archives = new Map();
  for (const artifact of manifest.artifacts) {
    assert.match(artifact.name, packageName);
    assert(
      !names.has(artifact.name) &&
        !Object.hasOwn(manifest.upstreamPackages, artifact.name),
    );
    names.set(artifact.name, artifact);
    assert.equal(artifact.version, input.version);
    assert.equal(artifact.filename, `${artifact.sha256}.tgz`);
    for (const archive of [
      artifact,
      ...(artifact.source ? [artifact.source] : []),
    ]) {
      assert.match(archive.sha256, hash);
      assert.match(archive.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/);
      assert.equal(
        archive.url,
        `${releaseBase(input.tag)}${archive.sha256}.tgz`,
        "Archive URL must use the exact release tag and content hash",
      );
      const previous = archives.get(archive.sha256);
      if (previous) assert.equal(previous.integrity, archive.integrity);
      archives.set(archive.sha256, archive);
    }
  }
  for (const name of required)
    assert(names.has(name), `Release omits required package: ${name}`);
  for (const artifact of names.values())
    validateDependencies(
      artifact.dependencies,
      names,
      manifest.upstreamPackages,
    );
  return { names, archives };
}

function validateDependencies(dependencies, names, upstream, sourceVersion) {
  assert(
    dependencies &&
      typeof dependencies === "object" &&
      !Array.isArray(dependencies),
  );
  const entries = Object.entries(dependencies);
  assert(entries.length < 256);
  for (const [name, spec] of entries) {
    assert.equal(typeof spec, "string");
    assert(spec.length < 1024);
    if (name.startsWith("@earendil-works/")) {
      const expected = names.has(name)
        ? (sourceVersion ?? names.get(name).url)
        : upstream[name];
      assert(expected, `Unknown Pi dependency: ${name}`);
      assert.equal(spec, expected, `Unpinned Pi dependency: ${name}`);
    }
  }
}

export function validateReport(report, manifest) {
  assert.equal(report.version, manifest.version);
  assert.equal(report.forkRevision, manifest.forkRevision);
  assert.equal(report.npm, "passed", "Published npm verification did not pass");
  assert.equal(report.bun, "passed", "Published Bun verification did not pass");
}

export async function validateArchive(bytes, artifact) {
  assert(bytes.length <= 64 * mib);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
    "Archive SHA-256 mismatch",
  );
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    artifact.integrity,
    "Archive integrity mismatch",
  );
  const unpacked = await promisify(gunzip)(bytes, {
    maxOutputLength: 256 * mib,
  });
  const paths = new Set();
  const payload = new Map();
  let pkg;
  await new Promise((resolve, reject) => {
    const parser = list({
      strict: true,
      onReadEntry(entry) {
        try {
          assert(paths.size < 20000, "Archive entry limit exceeded");
          assert(
            ["File", "Directory"].includes(entry.type),
            "Archive contains a link or special file",
          );
          const path = entry.path.replace(/\/$/, "");
          assert(path === "package" || path.startsWith("package/"));
          assert(
            !path.includes("\\") &&
              !path.split("/").some((part) => ["..", ".", ""].includes(part)),
            "Unsafe archive path",
          );
          assert(!paths.has(path), "Duplicate archive path");
          paths.add(path);
          assert(
            Number.isSafeInteger(entry.size) &&
              entry.size >= 0 &&
              entry.size <= 256 * mib,
          );
          if (entry.type !== "File") return;
          const digest = createHash("sha256");
          const chunks = [];
          if (path === "package/package.json") assert(entry.size <= mib);
          entry.on("data", (chunk) => {
            digest.update(chunk);
            if (path === "package/package.json") chunks.push(chunk);
          });
          entry.on("end", () => {
            try {
              if (path === "package/package.json")
                pkg = JSON.parse(Buffer.concat(chunks));
              else payload.set(path, `${entry.mode}:${digest.digest("hex")}`);
            } catch (error) {
              reject(error);
            }
          });
        } catch (error) {
          parser.abort(error);
        }
      },
    });
    parser.on("error", reject);
    parser.on("end", resolve);
    parser.end(unpacked);
  });
  assert(pkg, "Archive must contain package/package.json");
  assert.equal(
    Object.keys(pkg.scripts ?? {}).length,
    0,
    "Release packages must not define lifecycle scripts",
  );
  return { pkg, payload };
}

export function validatePackage(
  archive,
  artifact,
  manifest,
  names,
  source = false,
) {
  assert.equal(archive.pkg.name, artifact.name);
  assert.equal(
    archive.pkg.version,
    manifest.version,
    "Archive package version does not match the release tag",
  );
  validateDependencies(
    archive.pkg.dependencies ?? {},
    names,
    manifest.upstreamPackages,
    source ? manifest.version : undefined,
  );
  validateDependencies(
    archive.pkg.optionalDependencies ?? {},
    names,
    manifest.upstreamPackages,
    source ? manifest.version : undefined,
  );
  validateDependencies(
    archive.pkg.peerDependencies ?? {},
    names,
    manifest.upstreamPackages,
    manifest.version,
  );
  if (!source)
    assert.deepEqual(archive.pkg.dependencies ?? {}, artifact.dependencies);
}
