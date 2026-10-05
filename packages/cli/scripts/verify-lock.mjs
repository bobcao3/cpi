import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createReleaseLock } from "./release-lock.mjs";

export async function verifyReleaseLock(root, artifact, metadata) {
  const sourceBytes = await readFile(join(root, "package-lock.json"));
  const runtimeBytes = await readFile(join(artifact, "runtime-lock.json"));
  assert.equal(
    createHash("sha256").update(sourceBytes).digest("hex"),
    metadata.rootLockSha256,
  );
  assert.equal(
    createHash("sha256").update(runtimeBytes).digest("hex"),
    metadata.runtimeLockSha256,
  );
  const source = JSON.parse(sourceBytes);
  const runtime = JSON.parse(runtimeBytes);
  const manifest = JSON.parse(
    await readFile(join(artifact, "package.json"), "utf8"),
  );
  manifest.workspaces = runtime.packages[""].workspaces;
  const staged = Object.entries(runtime.packages)
    .filter(([directory]) => /^(?:packages|tools)\/[^/]+$/.test(directory))
    .map(([directory, manifest]) => ({ directory, manifest }));
  assert.deepEqual(createReleaseLock(source, manifest, staged), runtime);
  const registry = Object.keys(runtime.packages).find(
    (path) => runtime.packages[path].integrity,
  );
  assert(registry, "The release must contain locked registry dependencies");
  const damaged = structuredClone(source);
  delete damaged.packages[registry].integrity;
  assert.throws(
    () => createReleaseLock(damaged, manifest, staged),
    /lacks reviewed version, resolution, or integrity/,
  );
  const changed = structuredClone(staged);
  changed.find(
    (entry) => entry.manifest.name === "@cpi/cli",
  ).manifest.dependencies["@modelcontextprotocol/sdk"] = "0.0.0";
  assert.throws(
    () => createReleaseLock(source, manifest, changed),
    /External dependency differs from the reviewed manifest/,
  );
}
