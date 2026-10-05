import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { create } from "tar";
import { resolveGhostmux } from "@cpi/ghostmux";
import { stage_binary, stage_wrapper } from "@cpi/ghostmux/package";
import { platformKey } from "@cpi/ghostmux/source";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, data) =>
  writeFile(path, `${JSON.stringify(data, null, 2)}\n`);

export async function bundleGhostmux(extensions) {
  const platform = platformKey();
  const source = await resolveGhostmux();
  await stage_wrapper(extensions);
  return stage_binary(
    join(extensions, "node_modules", `@cpi/ghostmux-${platform}`),
    source,
    platform,
  );
}

async function inventory(directory) {
  const queue = [""];
  const packages = [];
  let files = 0;
  for (const relative of queue) {
    for (const entry of (
      await readdir(join(directory, relative), { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      assert(++files < 60000, "Release inventory exceeds the file limit");
      const local = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        queue.push(local);
        continue;
      }
      if (
        entry.name !== "package.json" ||
        !/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package.json$/.test(local)
      )
        continue;
      const manifest = await json(join(directory, local));
      packages.push({
        path: relative,
        name: manifest.name,
        version: manifest.version,
        license: manifest.license ?? "NOASSERTION",
      });
    }
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

export async function archiveRelease(destination, selected, metadata, env) {
  const bundle = join(destination, "bundle");
  await cp(join(destination, "node_modules/@cpi/cli"), bundle, {
    recursive: true,
  });
  await rename(join(destination, "node_modules"), join(bundle, "node_modules"));
  await rm(join(bundle, "node_modules/@cpi/cli"), { recursive: true });
  await rm(join(bundle, "node_modules/.bin"), { recursive: true, force: true });
  const packages = await inventory(bundle);
  const roots = packages.filter((entry) =>
    /^node_modules\/(?:@[^/]+\/)?[^/]+$/.test(entry.path),
  );
  const manifest = await json(join(bundle, "package.json"));
  manifest.private = false;
  manifest.dependencies = Object.fromEntries(
    roots.map(({ name, version }) => [name, version]),
  );
  manifest.bundledDependencies = roots.map(({ name }) => name);
  manifest.files = [
    "dist",
    "bin",
    "bootstrap.mjs",
    "bootstrap.d.mts",
    "LICENSE",
    "README.md",
    "release.json",
  ];
  manifest.os = [process.platform];
  manifest.cpu = [process.arch];
  const libc =
    process.platform === "linux"
      ? process.report.getReport().header.glibcVersionRuntime
        ? "glibc"
        : "musl"
      : undefined;
  if (libc) manifest.libc = [libc];
  const platform = [process.platform, process.arch, libc]
    .filter(Boolean)
    .join("-");
  await save(join(bundle, "package.json"), manifest);
  const release = {
    ...metadata,
    platform,
    packages,
    workspacePackages: selected.map(({ manifest: item }) => ({
      name: item.name,
      version: item.version,
    })),
  };
  await save(join(bundle, "release.json"), release);
  await copyFile(
    join(destination, "package-lock.json"),
    join(destination, "runtime-lock.json"),
  );
  const packed = spawnSync(
    "npm",
    ["pack", "--dry-run", "--ignore-scripts", "--json"],
    {
      cwd: bundle,
      env,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  assert.ifError(packed.error);
  assert.equal(packed.status, 0, packed.stderr);
  const info = Object.values(JSON.parse(packed.stdout))[0];
  assert.equal(info.name, manifest.name);
  const filename = `cpi-${manifest.version}-${platform}.tgz`;
  assert.deepEqual(
    new Set(info.bundled),
    new Set(manifest.bundledDependencies),
  );
  delete manifest.dependencies;
  await save(join(bundle, "package.json"), manifest);
  await create(
    {
      cwd: bundle,
      file: join(destination, filename),
      prefix: "package/",
      portable: true,
      mtime: new Date("1985-10-26T08:15:00Z"),
      gzip: true,
      noDirRecurse: true,
    },
    info.files.map(({ path }) => path).sort(),
  );
  const bytes = await readFile(join(destination, filename));
  await writeFile(
    join(destination, "SHA256SUMS"),
    `${digest(bytes)}  ${filename}\n`,
  );
  await save(join(destination, "release-manifest.json"), {
    filename,
    sha256: digest(bytes),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    ...release,
  });
  await chmod(join(bundle, "bin/cpi"), 0o755);
  console.log(`Release tarball: ${join(destination, filename)}`);
  return filename;
}
