import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const packageRoot = fileURLToPath(new URL("../", import.meta.url));
export const publicKey =
  "RWQWdcLzFjpLqtjewtcZo71AHJVUFws3irxz2ColvNW/r0m4tHyxzDX5";
export const releaseBase = "https://github.com/bobcao3/cpi/releases/download";

export function platformKey(
  platform = process.platform,
  architecture = process.arch,
) {
  if (
    !["linux", "darwin", "win32"].includes(platform) ||
    !["x64", "arm64"].includes(architecture)
  ) {
    throw new Error(`ghostmux does not distribute ${platform}/${architecture}`);
  }
  return `${platform}-${architecture}`;
}

export function artifactName(key) {
  return `ghostmux-${key}${key.startsWith("win32-") ? ".exe" : ""}`;
}

export async function sourceDigest(root = packageRoot) {
  const base = join(root, "tools", "ghostmux");
  const paths = ["build.zig", "build.zig.zon", "THIRD_PARTY_NOTICES.md"];
  for (const directory of ["src", "fonts"]) {
    const entries = await readdir(join(base, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (entry.name === ".zig-cache" || entry.name === "zig-out") continue;
      if (!entry.isFile())
        throw new Error(`Unexpected ghostmux source entry: ${entry.name}`);
      paths.push(`${directory}/${entry.name}`);
    }
  }
  const digest = createHash("sha256");
  for (const path of paths.sort()) {
    const bytes = await readFile(join(base, path));
    digest.update(`${path}\0${bytes.length}\0`);
    digest.update(bytes);
  }
  return digest.digest("hex");
}
