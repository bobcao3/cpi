import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { artifactName, platforms } from "../bin/ghostmux-source.mjs";
import { stage_binary, stage_wrapper } from "../bin/ghostmux-package.mjs";

const [input, output, requested] = process.argv.slice(2);
assert(
  input && output && process.argv.length <= 5,
  "Usage: package.mjs ARTIFACT_DIRECTORY NEW_DESTINATION [PLATFORM]",
);
const destination = resolve(output);
await assert.rejects(lstat(destination), { code: "ENOENT" });
await mkdir(destination, { recursive: true });
const selected = requested ? [requested] : Object.keys(platforms);
const packages = [];
for (const platform of selected) {
  const folder = join(destination, `ghostmux-${platform}`);
  const metadata = await stage_binary(
    folder,
    join(resolve(input), artifactName(platform)),
    platform,
  );
  packages.push({ folder, name: metadata.name });
}
const folder = join(destination, "ghostmux");
const wrapper = await stage_wrapper(folder);
packages.push({ folder, name: wrapper.name });
for (const pkg of packages) {
  const result = spawnSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    {
      cwd: pkg.folder,
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === "win32",
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const packed = Object.values(JSON.parse(result.stdout))[0];
  pkg.filename = packed.filename;
  pkg.integrity = packed.integrity;
  delete pkg.folder;
}
await writeFile(
  join(destination, "packages.json"),
  `${JSON.stringify(packages, null, 2)}\n`,
);
console.log(`Native packages followed by their wrapper: ${destination}`);
