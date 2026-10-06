import assert from "node:assert/strict";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { list, extract } from "tar";
import { manifestPaths, stageTree } from "./release-stage.mjs";

export async function stage_workspace(
  root,
  directory,
  destination,
  declarations,
) {
  const folder = join(root, directory);
  const manifest = JSON.parse(
    await readFile(join(folder, "package.json"), "utf8"),
  );
  const allowed = new Set([
    "README.md",
    "LICENSE",
    ...(manifest.files ?? ["src"])
      .filter((path) => !path.startsWith("!"))
      .map((path) =>
        path.split("/")[0] === "dist" ? "src" : path.split("/")[0],
      ),
  ]);
  await mkdir(destination, { recursive: true });
  await stageTree(folder, destination, folder, "", allowed);
  if (declarations)
    await cp(declarations, join(destination, "dist"), {
      recursive: true,
      filter: async (path) =>
        (await lstat(path)).isDirectory() || /\.d\.(ts|mts|cts)$/.test(path),
    });
  for (const key of ["exports", "main", "module", "bin", "pi", "files"])
    if (manifest[key]) manifest[key] = manifestPaths(manifest[key]);
  await copyFile(join(root, "LICENSE"), join(destination, "LICENSE"));
  return manifest;
}

export async function stage_pi(artifact, fork, destination, cache) {
  const url =
    artifact.url ??
    `https://github.com/bobcao3/pi/releases/download/pi-${fork.version}/${artifact.filename}`;
  assert.equal(new URL(url).protocol, "https:");
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `${artifact.name}: HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= 64 * 1024 * 1024, "Pi archive exceeds the size limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks, size);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    artifact.sha256,
  );
  assert.equal(
    `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    artifact.integrity,
  );
  const archive = join(cache, artifact.filename);
  await writeFile(archive, bytes);
  let files = 0;
  let expanded = 0;
  await list({
    file: archive,
    onReadEntry(entry) {
      assert(++files < 20000 && (expanded += entry.size) < 256 * 1024 * 1024);
      assert(
        ["File", "Directory"].includes(entry.type),
        `Unsupported archive entry: ${entry.path}`,
      );
      assert(
        entry.path.startsWith("package/") &&
          !entry.path.split("/").includes("..") &&
          !entry.path.includes("\\"),
      );
    },
  });
  await mkdir(destination);
  await extract({ file: archive, cwd: destination, strip: 1, strict: true });
  const manifest = JSON.parse(
    await readFile(join(destination, "package.json"), "utf8"),
  );
  assert.equal(manifest.name, artifact.name);
  assert.equal(manifest.version, artifact.version);
  return manifest;
}
