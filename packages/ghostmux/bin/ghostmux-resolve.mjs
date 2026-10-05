import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { packageRoot, platformKey, sourceDigest } from "./ghostmux-source.mjs";
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
  const name = `@cpi/ghostmux-${platform}`;
  let manifestPath;
  try {
    manifestPath = createRequire(import.meta.url).resolve(
      `${name}/package.json`,
    );
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    throw new Error(
      `Missing ${name}. Reinstall @cpi/ghostmux with optional dependencies enabled, or build the checkout's native binary.`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const wrapper = JSON.parse(
    await readFile(join(packageRoot, "package.json"), "utf8"),
  );
  if (manifest.name !== name || manifest.version !== wrapper.version)
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
