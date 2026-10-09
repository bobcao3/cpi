import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { init } from "es-module-lexer";
import { stage_binary, stage_wrapper } from "@cpi/ghostmux/package";
import { artifactName, platforms } from "@cpi/ghostmux/source";
import { stage_wasm } from "@cpi/tree-sitter-wasm/package";
import { emitDeclarations } from "./release-declarations.mjs";
import { prepareReleaseSources } from "./release-sources.mjs";
import { registry_manifest } from "./registry-manifest.mjs";
import { stage_pi, stage_workspace } from "./registry-stage.mjs";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const [native_input, output, selected] = process.argv.slice(2);
assert(
  native_input && output && process.argv.length <= 5,
  "Usage: package-registry.mjs SIGNED_NATIVE_DIRECTORY NEW_DESTINATION [PLATFORM]",
);
const input = resolve(native_input);
const destination = resolve(output);
await assert.rejects(lstat(destination), { code: "ENOENT" });
await mkdir(destination, { recursive: true });
const temporary = await mkdtemp(join(dirname(destination), "cpi-registry-"));
let snapshot;
try {
  snapshot = await prepareReleaseSources(checkout, temporary);
  const root = snapshot.root;
  const fork = JSON.parse(
    await readFile(join(root, "vendor/pi/manifest.json"), "utf8"),
  );
  const cli_folder = join(root, "packages/cli");
  const cli = JSON.parse(
    await readFile(join(cli_folder, "package.json"), "utf8"),
  );
  const declarations = await emitDeclarations(root, [
    { folder: cli_folder, original: "packages/cli", manifest: cli },
  ]);
  const versions = new Map(
    fork.artifacts.map((artifact) => [artifact.name, artifact.version]),
  );
  const entries = [];
  for (const directory of ["cli", "harness", "ghostmux", "tree-sitter-wasm"]) {
    const manifest = JSON.parse(
      await readFile(join(root, "packages", directory, "package.json"), "utf8"),
    );
    versions.set(manifest.name, manifest.version);
  }
  for (const platform of Object.keys(platforms))
    versions.set(`@cpi/ghostmux-${platform}`, versions.get("@cpi/ghostmux"));
  for (const artifact of fork.artifacts) {
    const directory = join(destination, artifact.name.split("/")[1]);
    entries.push({
      directory,
      manifest: await stage_pi(artifact, fork, directory, temporary),
    });
  }
  await init;
  for (const name of ["harness", "cli"]) {
    const directory = join(destination, name);
    entries.push({
      directory,
      manifest: await stage_workspace(
        root,
        `packages/${name}`,
        directory,
        name === "cli" ? declarations.get(cli.name) : undefined,
      ),
    });
  }
  for (const platform of selected ? [selected] : Object.keys(platforms)) {
    const directory = join(destination, `ghostmux-${platform}`);
    await stage_binary(
      directory,
      join(input, artifactName(platform)),
      platform,
    );
    entries.push({
      directory,
      manifest: JSON.parse(
        await readFile(join(directory, "package.json"), "utf8"),
      ),
    });
  }
  const ghostmux_directory = join(destination, "ghostmux");
  entries.push({
    directory: ghostmux_directory,
    manifest: await stage_wrapper(ghostmux_directory),
  });
  const wasm_directory = join(destination, "tree-sitter-wasm");
  entries.push({
    directory: wasm_directory,
    manifest: await stage_wasm(
      wasm_directory,
      join(input, "tree-sitter-wasm.wasm"),
    ),
  });
  const packages = [];
  for (const { directory, manifest: source } of entries) {
    const manifest = registry_manifest(source, versions);
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const packed = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    assert.ifError(packed.error);
    assert.equal(packed.status, 0, packed.stdout + packed.stderr);
    const info = Object.values(JSON.parse(packed.stdout))[0];
    const bytes = await readFile(join(destination, info.filename));
    packages.push({
      name: manifest.name,
      version: manifest.version,
      directory: directory.slice(destination.length + 1),
      filename: info.filename,
      integrity: info.integrity,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  packages.sort(
    (a, b) =>
      Number(a.name === "@bobcao3/cpi") - Number(b.name === "@bobcao3/cpi"),
  );
  await writeFile(
    join(destination, "packages.json"),
    `${JSON.stringify(packages, null, 2)}\n`,
  );
  await writeFile(
    join(destination, "SHA256SUMS"),
    packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}\n`).join(""),
  );
  await writeFile(
    join(destination, "fork-provenance.json"),
    `${JSON.stringify(fork, null, 2)}\n`,
  );
  console.log(
    `Prepared ${packages.length} registry packages, without install scripts: ${destination}`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
