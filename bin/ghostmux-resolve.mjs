import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  artifactName,
  packageRoot,
  platformKey,
  releaseBase,
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

async function verified(path, digest, platform) {
  if (!(await executable(path))) return false;
  const [bytes, signature] = await Promise.all([
    readFile(path),
    readFile(`${path}.minisig`, "utf8"),
  ]);
  verifyArtifact(bytes, signature, digest, platform);
  return true;
}

async function download(url, limit) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok)
    throw new Error(
      `Ghostmux release download failed (${response.status}): ${url}`,
    );
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error("Ghostmux artifact exceeds the download limit");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error("Ghostmux artifact exceeds the download limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks, size);
}

export async function resolveGhostmux() {
  const override = process.env.GHOSTMUX_BIN;
  if (override) {
    if (!isAbsolute(override) || !(await executable(override)))
      throw new Error("GHOSTMUX_BIN must name an absolute executable path");
    return override;
  }
  const platform = platformKey();
  const filename = artifactName(platform);
  const digest = await sourceDigest();
  const bundled = join(packageRoot, "bin", "ghostmux-platform", filename);
  if (await verified(bundled, digest, platform)) return bundled;
  const development = join(
    packageRoot,
    "tools",
    "ghostmux",
    "zig-out",
    "bin",
    process.platform === "win32" ? "ghostmux.exe" : "ghostmux",
  );
  if (await executable(development)) return development;
  if (process.env.GHOSTMUX_BUILD === "1") {
    const result = spawnSync("zig", ["build", "--release=safe"], {
      cwd: join(packageRoot, "tools", "ghostmux"),
      stdio: "inherit",
      timeout: 600000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0 || !(await executable(development)))
      throw new Error("Ghostmux source build failed");
    return development;
  }
  const cacheBase =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const directory = join(cacheBase, "cpi", "ghostmux", digest, platform);
  const binary = join(directory, filename);
  if (await verified(binary, digest, platform)) return binary;
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(directory), ".install-"));
  try {
    const base = `${releaseBase}/ghostmux-${digest}/${filename}`;
    const [bytes, signature] = await Promise.all([
      download(base, 128 * 1024 * 1024),
      download(`${base}.minisig`, 8192),
    ]);
    verifyArtifact(bytes, signature.toString("utf8"), digest, platform);
    const staged = join(staging, filename);
    await writeFile(staged, bytes, { mode: 0o700 });
    await writeFile(`${staged}.minisig`, signature, { mode: 0o600 });
    await chmod(staged, 0o700);
    try {
      await rename(staging, directory);
    } catch (error) {
      if (
        (error.code === "EEXIST" || error.code === "ENOTEMPTY") &&
        (await verified(binary, digest, platform))
      )
        return binary;
      throw error;
    }
    return binary;
  } catch (error) {
    throw new Error(
      `${error.message}. No matching published ghostmux release may exist. Set GHOSTMUX_BIN to a trusted native binary, or opt into an installed Zig compiler with GHOSTMUX_BUILD=1.`,
      { cause: error },
    );
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
