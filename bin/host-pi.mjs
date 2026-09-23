import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const MAX_PATH_ENTRIES = 128;
const MAX_PARENTS = 8;
const MAX_MANIFEST_BYTES = 256 * 1024;

function packageName(manifest) {
  if (!existsSync(manifest)) return undefined;
  if (statSync(manifest).size > MAX_MANIFEST_BYTES)
    throw new Error(`Pi package manifest exceeds limit: ${manifest}`);
  return JSON.parse(readFileSync(manifest, "utf8")).name;
}

function packageRoot(entry) {
  let directory = dirname(realpathSync(entry));
  for (let depth = 0; depth < MAX_PARENTS; depth++) {
    const manifest = join(directory, "package.json");
    if (packageName(manifest) === PACKAGE_NAME) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

export function activePiRoot() {
  const explicit = process.env.CPI_PI_HOST_ENTRY;
  const launched =
    process.argv[1] && existsSync(process.argv[1])
      ? packageRoot(process.argv[1])
      : undefined;
  const shellEntry = process.env._;
  const shellRoot =
    shellEntry && existsSync(shellEntry) ? packageRoot(shellEntry) : undefined;
  if (launched && shellRoot && launched !== shellRoot)
    throw new Error(
      `Pi host mismatch: launched ${launched}, shell ${shellRoot}`,
    );
  const active = launched ?? shellRoot;
  if (explicit) {
    const root = packageRoot(explicit);
    if (!root) throw new Error(`Not a Pi executable: ${explicit}`);
    if (active && active !== root)
      throw new Error(
        `Pi host mismatch: launched ${active}, configured ${root}`,
      );
    return root;
  }
  if (active) return active;
  throw new Error(
    "Cannot identify the active Pi package; set CPI_PI_HOST_ENTRY to its executable",
  );
}

export function piExecutableOnPath() {
  for (const directory of (process.env.PATH ?? "")
    .split(delimiter)
    .slice(0, MAX_PATH_ENTRIES)) {
    if (!directory) continue;
    const candidate = join(directory, "pi");
    if (!existsSync(candidate)) continue;
    if (packageRoot(candidate)) return candidate;
  }
  throw new Error("Cannot locate an installed Pi executable on PATH");
}

export async function hostCodingAgent() {
  const entry = join(activePiRoot(), "dist/index.js");
  if (!existsSync(entry)) throw new Error(`Pi SDK entry unavailable: ${entry}`);
  return import(pathToFileURL(entry).href);
}

export async function hostAi() {
  const root = activePiRoot();
  for (const directory of [
    join(root, "node_modules", "@earendil-works", "pi-ai"),
    join(dirname(root), "pi-ai"),
  ]) {
    const manifest = join(directory, "package.json");
    const entry = join(directory, "dist/compat.js");
    if (packageName(manifest) === "@earendil-works/pi-ai" && existsSync(entry))
      return import(pathToFileURL(entry).href);
  }
  throw new Error("Pi AI SDK unavailable alongside the active Pi package");
}
