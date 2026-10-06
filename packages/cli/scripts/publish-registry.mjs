import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { archive_manifest } from "./registry-archive.mjs";

assert.equal(
  process.argv.length,
  3,
  "Usage: publish-registry.mjs VERIFIED_PACKAGE_DIRECTORY",
);
const directory = resolve(process.argv[2]);
const packages = JSON.parse(
  await readFile(join(directory, "packages.json"), "utf8"),
);
assert(packages.length > 0 && packages.length < 32);
assert.equal(packages.at(-1).name, "@bobcao3/cpi");
const packages_sha256 = createHash("sha256")
  .update(await readFile(join(directory, "packages.json")))
  .digest("hex");
const verified = new Set();
for (const folder of await readdir(join(directory, "verification"))) {
  const report = JSON.parse(
    await readFile(
      join(directory, "verification", folder, "registry-verification.json"),
      "utf8",
    ),
  );
  assert.equal(
    report.packagesSha256,
    packages_sha256,
    "Verification belongs to a different package set",
  );
  assert.deepEqual(report.managers, ["npm", "bun"]);
  assert.equal(report.lifecycleScripts, false);
  verified.add(`${report.platform}-${report.arch}`);
}
for (const platform of [
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
])
  assert(
    verified.has(platform),
    `Missing installation verification: ${platform}`,
  );
const pending = [];
for (const pkg of packages) {
  assert(pkg.name.startsWith("@bobcao3/"));
  assert.equal(pkg.filename, pkg.filename.split(/[\\/]/).at(-1));
  const path = join(directory, pkg.filename);
  const bytes = await readFile(path);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), pkg.sha256);
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    pkg.integrity,
  );
  const manifest = await archive_manifest(path);
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.scripts, undefined);
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    {
      signal: AbortSignal.timeout(30000),
    },
  );
  if (response.status === 404) pending.push(pkg);
  else {
    assert(response.ok, `${pkg.name}: HTTP ${response.status}`);
    assert.equal(
      (await response.json()).dist.integrity,
      pkg.integrity,
      `Published version differs: ${pkg.name}@${pkg.version}; bump its version`,
    );
  }
}
for (const pkg of pending) {
  const result = spawnSync(
    "npm",
    [
      "publish",
      join(directory, pkg.filename),
      "--access",
      "public",
      "--tag",
      "latest",
      "--ignore-scripts",
    ],
    {
      stdio: "inherit",
      timeout: 120000,
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Publication failed: ${pkg.name}`);
}
console.log(
  "Registry packages published; cpi was published after its dependencies.",
);
