import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  packageRoot,
  platformKey,
  platforms,
  sourceDigest,
} from "./ghostmux-source.mjs";
import { verifyArtifact } from "./ghostmux-signature.mjs";

const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

export async function stage_binary(
  destination,
  binary,
  platform = platformKey(),
) {
  assert(
    Object.hasOwn(platforms, platform),
    `Unsupported platform: ${platform}`,
  );
  const manifest = await json(join(packageRoot, "package.json"));
  const source_sha256 = await sourceDigest();
  const bytes = await readFile(binary);
  const signature = await readFile(`${binary}.minisig`, "utf8");
  verifyArtifact(bytes, signature, source_sha256, platform);
  const [os, cpu] = platform.split("-");
  const name = `@cpi/ghostmux-${platform}`;
  const filename = os === "win32" ? "ghostmux.exe" : "ghostmux";
  await mkdir(join(destination, "bin"), { recursive: true });
  const target = join(destination, "bin", filename);
  await writeFile(target, bytes, { mode: 0o755 });
  await chmod(target, 0o755);
  await writeFile(`${target}.minisig`, signature);
  await cp(join(packageRoot, "licenses"), join(destination, "licenses"), {
    recursive: true,
  });
  await copyFile(join(packageRoot, "LICENSE"), join(destination, "LICENSE"));
  const provenance = {
    platform,
    target: platforms[platform].target,
    cpu_baseline: platforms[platform].baseline,
    source_sha256,
    binary_sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  await save(join(destination, "native.json"), provenance);
  await save(join(destination, "package.json"), {
    name,
    version: manifest.version,
    license: manifest.license,
    description: `Ghostmux executable for ${platform}; CPU requirement: ${provenance.cpu_baseline}`,
    os: [os],
    cpu: [cpu],
    exports: { "./package.json": "./package.json" },
    files: ["bin", "licenses", "LICENSE", "native.json"],
  });
  return { name, version: manifest.version, ...provenance };
}

export async function stage_wrapper(destination) {
  const manifest = await json(join(packageRoot, "package.json"));
  await mkdir(destination, { recursive: true });
  for (const file of manifest.files) {
    if (["native.json"].includes(file)) continue;
    await mkdir(dirname(join(destination, file)), { recursive: true });
    await cp(join(packageRoot, file), join(destination, file), {
      recursive: true,
    });
  }
  delete manifest.private;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.exports["./package"];
  manifest.optionalDependencies = Object.fromEntries(
    Object.keys(platforms).map((key) => [
      `@cpi/ghostmux-${key}`,
      manifest.version,
    ]),
  );
  await save(join(destination, "native.json"), {
    source_sha256: await sourceDigest(),
  });
  await save(join(destination, "package.json"), manifest);
  return manifest;
}
