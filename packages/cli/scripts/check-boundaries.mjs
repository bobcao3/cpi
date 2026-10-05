import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { init, parse } from "es-module-lexer";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packages = join(root, "packages");
let count = 0;
await init;
for (const entry of await readdir(packages, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const directory = join(packages, entry.name);
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(join(directory, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  const owned = manifest.name.startsWith("@cpi/");
  if (!owned) {
    for (const name of Object.keys({
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    })) {
      assert(
        !name.startsWith("@cpi/"),
        `${manifest.name} depends on downstream ${name}`,
      );
    }
  }
  const queue = owned ? ["src", "extensions", "bin"] : ["src"];
  for (const folder of queue) {
    let children;
    try {
      children = await readdir(join(directory, folder), {
        withFileTypes: true,
      });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const child of children) {
      const local = join(folder, child.name);
      assert(++count < 12000, "Boundary scan exceeded the file limit");
      if (child.isDirectory()) {
        queue.push(local);
        continue;
      }
      if (
        !/\.(?:ts|js|mjs)$/.test(local) ||
        /\.(?:test|spec|d)\.ts$/.test(local)
      )
        continue;
      const path = join(directory, local);
      let text = await readFile(path, "utf8");
      assert(
        text.length < 16 * 1024 * 1024,
        `Source exceeds scan limit: ${path}`,
      );
      if (local.endsWith(".ts"))
        text = (await transform(text, { loader: "ts", format: "esm" })).code;
      for (const { n: specifier } of parse(text)[0]) {
        if (!specifier) continue;
        if (!owned)
          assert(
            !specifier.includes("@cpi/") &&
              !/cpi(?:-extensions)?\//.test(specifier),
            `${path} imports downstream ${specifier}`,
          );
        if (!owned) continue;
        assert(
          !/^@earendil-works\/[^/]+\/(?:src|dist)\//.test(specifier),
          `${path} imports private host source: ${specifier}`,
        );
        if (specifier.startsWith(".")) {
          const target = relative(directory, resolve(dirname(path), specifier));
          assert(
            !target.startsWith(".."),
            `${path} crosses a package boundary: ${specifier}`,
          );
        }
      }
    }
  }
}
console.log(
  "Native packages have no cpi dependencies; cpi runtime imports stay within public package boundaries.",
);
