import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { packageRoot, verifyArtifact } from "../resolve.ts";

export async function stage_wasm(destination, artifact) {
  const bytes = await readFile(artifact);
  const signature = await readFile(`${artifact}.minisig`, "utf8");
  verifyArtifact(bytes, signature);
  await mkdir(join(destination, "assets"), { recursive: true });
  await writeFile(join(destination, "assets/tree-sitter-wasm.wasm"), bytes);
  await writeFile(
    join(destination, "assets/tree-sitter-wasm.wasm.minisig"),
    signature,
  );
  await build({
    absWorkingDir: packageRoot,
    entryPoints: ["index.ts", "resolve.ts"],
    outdir: destination,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    splitting: true,
    chunkNames: "runtime",
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "none",
  });
  const compiler = join(
    dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
    "bin/tsc",
  );
  const declarations = spawnSync(
    process.execPath,
    [
      compiler,
      "--ignoreConfig",
      "--types",
      "node",
      "--declaration",
      "--emitDeclarationOnly",
      "--skipLibCheck",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--target",
      "ES2022",
      "--allowImportingTsExtensions",
      "--outDir",
      destination,
      "index.ts",
      "resolve.ts",
    ],
    {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 120000,
    },
  );
  assert.ifError(declarations.error);
  assert.equal(
    declarations.status,
    0,
    declarations.stdout + declarations.stderr,
  );
  for (const name of ["README.md", "LICENSE"])
    await copyFile(join(packageRoot, name), join(destination, name));
  await cp(join(packageRoot, "licenses"), join(destination, "licenses"), {
    recursive: true,
  });
  const manifest = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.dependencies;
  delete manifest.exports["./package"];
  manifest.exports["."].types = "./index.d.ts";
  manifest.exports["."].default = "./index.mjs";
  manifest.exports["./resolve"].types = "./resolve.d.ts";
  manifest.exports["./resolve"].default = "./resolve.mjs";
  manifest.files = [
    "*.mjs",
    "*.d.ts",
    "assets",
    "licenses",
    "README.md",
    "LICENSE",
  ];
  await writeFile(
    join(destination, "package.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}
