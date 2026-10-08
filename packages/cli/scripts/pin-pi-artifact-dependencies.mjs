import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { extract, list } from "tar";

const [inputArg, outputArg, baseArg] = process.argv.slice(2);
assert(
  inputArg && outputArg && baseArg && process.argv.length === 5,
  "Usage: pin-pi-artifact-dependencies.mjs VERIFIED_ARTIFACT_DIRECTORY NEW_DESTINATION RELEASE_BASE_URL",
);
const input = resolve(inputArg);
const output = resolve(outputArg);
const base = new URL(`${baseArg.replace(/\/$/, "")}/`);
assert(
  base.protocol === "https:" &&
    !base.username &&
    !base.password &&
    !base.search &&
    !base.hash,
);
await assert.rejects(lstat(output), { code: "ENOENT" });
const manifest = JSON.parse(
  await readFile(join(input, "manifest.json"), "utf8"),
);
assert.equal(manifest.format, 1);
assert(manifest.artifacts.length > 0 && manifest.artifacts.length < 32);
const pending = new Map(
  manifest.artifacts.map((artifact) => [artifact.name, artifact]),
);
assert.equal(pending.size, manifest.artifacts.length);
const closed = new Map();
await mkdir(output, { recursive: true });
const staging = join(output, "staging");

async function payload(archive) {
  const files = new Map();
  let entries = 0;
  let size = 0;
  await list({
    file: archive,
    strict: true,
    onReadEntry(entry) {
      assert(++entries < 20000 && (size += entry.size) < 256 * 1024 * 1024);
      assert(["File", "Directory"].includes(entry.type));
      assert(
        entry.path.startsWith("package/") &&
          !entry.path.split("/").includes("..") &&
          !entry.path.includes("\\"),
      );
      if (entry.type !== "File") return;
      assert(!files.has(entry.path));
      const digest = createHash("sha256");
      files.set(entry.path, undefined);
      entry.on("data", (bytes) => digest.update(bytes));
      entry.on("end", () =>
        files.set(entry.path, `${entry.mode}:${digest.digest("hex")}`),
      );
    },
  });
  files.delete("package/package.json");
  return [...files].sort(([a], [b]) => a.localeCompare(b));
}

try {
  for (let pass = 0; pending.size && pass < manifest.artifacts.length; pass++) {
    const previous = pending.size;
    for (const [name, artifact] of pending) {
      assert(name.startsWith("@earendil-works/"));
      assert.equal(artifact.version, manifest.version);
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(artifact.filename, `${artifact.sha256}.tgz`);
      const archive = join(input, artifact.filename);
      assert((await lstat(archive)).size <= 64 * 1024 * 1024);
      const bytes = await readFile(archive);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        artifact.sha256,
      );
      assert.equal(
        `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
        artifact.integrity,
      );
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging);
      const originalPayload = await payload(archive);
      await extract({ file: archive, cwd: staging, strict: true });
      const folder = join(staging, "package");
      const packagePath = join(folder, "package.json");
      const pkg = JSON.parse(await readFile(packagePath, "utf8"));
      assert.equal(pkg.name, name);
      assert.equal(pkg.version, manifest.version);
      const dependencies = Object.keys({
        ...pkg.dependencies,
        ...pkg.optionalDependencies,
      }).filter((dependency) => dependency.startsWith("@earendil-works/"));
      for (const dependency of dependencies)
        assert(
          closed.has(dependency) || pending.has(dependency),
          `Incomplete fork closure: ${dependency}`,
        );
      if (dependencies.some((dependency) => !closed.has(dependency))) continue;
      let filename = artifact.filename;
      if (dependencies.length) {
        for (const field of ["dependencies", "optionalDependencies"])
          for (const dependency of Object.keys(pkg[field] ?? {}))
            if (closed.has(dependency))
              pkg[field][dependency] = closed.get(dependency).url;
        await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
        const packed = spawnSync(
          "npm",
          ["pack", "--ignore-scripts", "--json", "--pack-destination", output],
          {
            cwd: folder,
            encoding: "utf8",
            timeout: 120000,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        assert.ifError(packed.error);
        assert.equal(packed.status, 0, packed.stdout + packed.stderr);
        const info = Object.values(JSON.parse(packed.stdout))[0];
        const packedPath = join(output, info.filename);
        assert.deepEqual(
          await payload(packedPath),
          originalPayload,
          `${name}: package payload changed`,
        );
        const packedBytes = await readFile(packedPath);
        const sha256 = createHash("sha256").update(packedBytes).digest("hex");
        filename = `${sha256}.tgz`;
        await rename(packedPath, join(output, filename));
        artifact.source = {
          sha256: artifact.sha256,
          integrity: artifact.integrity,
          url: artifact.url ?? new URL(artifact.filename, base).href,
        };
        artifact.sha256 = sha256;
        artifact.integrity = `sha512-${createHash("sha512").update(packedBytes).digest("base64")}`;
        artifact.dependencies = pkg.dependencies ?? {};
      } else {
        await copyFile(archive, join(output, filename));
      }
      artifact.filename = filename;
      artifact.url = new URL(filename, base).href;
      closed.set(name, artifact);
      pending.delete(name);
      console.log(`${name}: ${filename}`);
    }
    assert(pending.size < previous, "Fork dependency graph contains a cycle");
  }
  assert.equal(pending.size, 0);
  await writeFile(
    join(output, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(output, "SHA256SUMS"),
    manifest.artifacts
      .map((artifact) => `${artifact.sha256}  ${artifact.filename}\n`)
      .join(""),
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
