import { constants } from "node:fs";
import { existsSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import {
  artifactName,
  packageRoot,
  platformKey,
  releaseTag,
  sourceDigest,
} from "./ghostmux-source.mjs";
import { verifyArtifact } from "./ghostmux-signature.mjs";

async function executable(path) {
  try {
    await access(
      path,
      process.platform === "win32" ? constants.F_OK : constants.X_OK,
    );
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "EACCES") return false;
    throw error;
  }
}

export async function resolveGhostmux() {
  const override = process.env.GHOSTMUX_BIN;
  if (override) {
    if (!isAbsolute(override) || !(await executable(override)))
      throw new Error("GHOSTMUX_BIN must name an absolute executable path");
    return override;
  }
  const filename = process.platform === "win32" ? "ghostmux.exe" : "ghostmux";
  const development = join(packageRoot, "zig-out/bin", filename);
  if (await executable(development)) return development;
  if (process.env.GHOSTMUX_BUILD === "1") {
    const result = spawnSync("zig", ["build", "--release=safe"], {
      cwd: packageRoot,
      stdio: "inherit",
      timeout: 600000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !(await executable(development)))
      throw new Error("Ghostmux source build failed");
    return development;
  }
  const platform = platformKey();
  const artifact = artifactName(platform);
  if (existsSync(join(packageRoot, "src")))
    return sourceReleaseBinary(artifact, platform);
  const name = `@cpi/ghostmux-${platform}`;
  let manifestPath;
  try {
    manifestPath = createRequire(import.meta.url).resolve(
      `${name}/package.json`,
    );
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    throw new Error(
      `Missing ${name}. Reinstall @bobcao3/cpi-ghostmux with optional dependencies enabled, or build the checkout's native binary.`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const wrapper = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  const spec = wrapper.optionalDependencies?.[name];
  const expected_name = spec?.startsWith("npm:")
    ? spec.slice(4, spec.lastIndexOf("@"))
    : name;
  const expected_version = spec?.startsWith("npm:")
    ? spec.slice(spec.lastIndexOf("@") + 1)
    : spec;
  if (manifest.name !== expected_name || manifest.version !== expected_version)
    throw new Error(`Ghostmux binary package version mismatch: ${name}`);
  const binary = join(dirname(manifestPath), "bin", filename);
  if (!(await executable(binary)))
    throw new Error(`Missing executable in ${name}`);
  verifyArtifact(
    await readFile(binary),
    await readFile(`${binary}.minisig`, "utf8"),
    await sourceDigest(),
    platform,
  );
  return binary;
}

async function sourceReleaseBinary(name, platform) {
  const digest = await sourceDigest();
  const directory = join(tmpdir(), "cpi-ghostmux", digest.slice(0, 16));
  const binary = join(directory, name);
  const signature = `${binary}.minisig`;
  if (existsSync(binary) && existsSync(signature)) {
    try {
      verifyArtifact(
        await readFile(binary),
        await readFile(signature, "utf8"),
        digest,
        platform,
      );
      await chmod(binary, 0o755);
      return binary;
    } catch {}
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const [bytes, block] = await Promise.all([
    releaseAsset(name),
    releaseAsset(`${name}.minisig`),
  ]);
  verifyArtifact(bytes, block.toString("utf8"), digest, platform);
  const staging = `${binary}.${process.pid}.tmp`;
  await writeFile(staging, bytes, { mode: 0o755 });
  await rename(staging, binary);
  await writeFile(signature, block);
  await chmod(binary, 0o755);
  return binary;
}

async function releaseAsset(name) {
  const response = await fetch(
    `https://github.com/bobcao3/cpi/releases/download/${releaseTag}/${name}`,
    { signal: AbortSignal.timeout(120000) },
  );
  if (!response.ok)
    throw new Error(
      `Missing signed Ghostmux download ${name}: HTTP ${response.status}`,
    );
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 128 * 1024 * 1024)
      throw new Error("Ghostmux download exceeds the size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
