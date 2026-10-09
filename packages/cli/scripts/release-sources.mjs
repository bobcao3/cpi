import assert from "node:assert/strict";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, join, relative } from "node:path";

async function linkModules(source, destination, locals) {
  let entries;
  try {
    entries = await readdir(source);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  await mkdir(destination);
  const modules = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      await mkdir(join(destination, entry));
      for (const child of await readdir(join(source, entry)))
        modules.push(`${entry}/${child}`);
    } else modules.push(entry);
  }
  for (const name of modules)
    await symlink(
      locals.get(name) ?? (await realpath(join(source, name))),
      join(destination, name),
    );
}

export async function prepareReleaseSources(checkout, cache) {
  const root = await mkdtemp(join(cache, "cpi-release-source-"));
  const skipped = new Set([
    "node_modules",
    "dist",
    ".git",
    ".jj",
    ".zig-cache",
    "zig-pkg",
    "zig-out",
    ".artifacts",
    ".cache",
    "coverage",
    ".env",
    "auth.json",
  ]);
  let files = 0;
  let bytes = 0;
  try {
    for (const folder of ["packages", "vendor/pi"]) {
      await cp(join(checkout, folder), join(root, folder), {
        recursive: true,
        filter: async (path) => {
          assert(
            ++files < 40000,
            "Release source snapshot exceeds the file limit",
          );
          if (skipped.has(basename(path))) return false;
          const stats = await lstat(path);
          assert(
            !stats.isSymbolicLink(),
            `Source snapshot contains a symlink: ${path}`,
          );
          bytes += stats.size;
          assert(
            bytes < 512 * 1024 * 1024,
            "Release source snapshot exceeds the byte limit",
          );
          return true;
        },
      });
    }
    for (const name of ["package.json", "package-lock.json", "LICENSE"])
      await cp(join(checkout, name), join(root, name));
    const locals = new Map();
    for (const folder of [
      "packages/cli",
      "packages/harness",
      "packages/ghostmux",
      "packages/tree-sitter-wasm",
    ]) {
      const directory = join(root, folder);
      locals.set(
        JSON.parse(await readFile(join(directory, "package.json"), "utf8"))
          .name,
        directory,
      );
    }
    await linkModules(
      join(checkout, "node_modules"),
      join(root, "node_modules"),
      locals,
    );
    for (const directory of locals.values()) {
      await linkModules(
        join(checkout, relative(root, directory), "node_modules"),
        join(directory, "node_modules"),
        locals,
      );
    }
    return { root };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
