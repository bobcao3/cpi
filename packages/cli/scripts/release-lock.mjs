import { posix } from "node:path";

const manifestFields = [
  "name",
  "version",
  "license",
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bin",
  "engines",
  "os",
  "cpu",
  "libc",
  "funding",
];

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

function manifestEntry(manifest) {
  return Object.fromEntries(
    manifestFields
      .filter((field) => manifest[field] !== undefined)
      .map((field) => [field, manifest[field]]),
  );
}

function resolveDependency(packages, from, name) {
  let directory = from;
  for (;;) {
    if (posix.basename(directory) !== "node_modules") {
      const candidate = `${directory ? `${directory}/` : ""}node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
    }
    if (!directory) return undefined;
    const parent = posix.dirname(directory);
    directory = parent === "." ? "" : parent;
  }
}

/**
 * rootLock is the reviewed repository package-lock.json (version 3).
 * rootManifest is OUTPUT/package.json, including the repository's reviewed overrides.
 * stagedWorkspaces is an array of { directory, manifest }, where directory is the
 * original root-relative path (for example, "packages/cli") and manifest is the
 * rewritten production package.json. The caller must stage the same directories.
 * The returned version-3 lock matches rootManifest without modifying any input.
 * The function performs no I/O and does not resolve packages through a registry.
 */
export function createReleaseLock(rootLock, rootManifest, stagedWorkspaces) {
  if (rootLock.lockfileVersion !== 3 || !rootLock.packages?.[""]) {
    throw new Error(
      "The reviewed root lock must have lockfileVersion 3 and a root package entry",
    );
  }
  const source = rootLock.packages;
  const staged = new Map();
  const directories = new Set();
  const workspaceNames = new Set();
  for (const entry of Object.values(source)) {
    if (entry.link) {
      const workspace = source[entry.resolved];
      if (!workspace?.name)
        throw new Error(`Invalid reviewed workspace link: ${entry.resolved}`);
      workspaceNames.add(workspace.name);
    }
  }
  for (const { directory, manifest } of stagedWorkspaces) {
    if (
      !/^(?:packages|tools)\/[^/]+$/.test(directory) ||
      directory.includes("\\") ||
      directory.endsWith("/..")
    ) {
      throw new Error(`Invalid staged workspace directory: ${directory}`);
    }
    if (
      !manifest?.name ||
      !manifest.version ||
      staged.has(manifest.name) ||
      directories.has(directory)
    ) {
      throw new Error(`Invalid or duplicate staged workspace: ${directory}`);
    }
    if (
      source[directory]?.name !== manifest.name ||
      source[`node_modules/${manifest.name}`]?.resolved !== directory
    ) {
      throw new Error(
        `Staged workspace lacks reviewed source provenance: ${directory}`,
      );
    }
    if (manifest.devDependencies || manifest.scripts || manifest.workspaces) {
      throw new Error(
        `Staged workspace must strip development dependencies, scripts, and workspaces: ${directory}`,
      );
    }
    staged.set(manifest.name, { directory, manifest });
    directories.add(directory);
  }
  const cli = staged.get("@cpi/cli");
  if (!cli) throw new Error("The staged workspaces must include @cpi/cli");
  if (
    rootManifest.name !== "cpi-release" ||
    rootManifest.version !== cli.manifest.version ||
    rootManifest.devDependencies ||
    rootManifest.scripts ||
    JSON.stringify(sorted(rootManifest.dependencies)) !==
      JSON.stringify(
        sorted({
          ...source[""].dependencies,
          "@cpi/cli": cli.manifest.version,
        }),
      ) ||
    !Array.isArray(rootManifest.workspaces) ||
    JSON.stringify([...rootManifest.workspaces].sort()) !==
      JSON.stringify([...directories].sort())
  ) {
    throw new Error(
      "The release root manifest must match cpi-release and the supplied staged workspaces",
    );
  }
  const release = {
    ...manifestEntry(rootManifest),
    workspaces: [...directories].sort(),
  };
  const packages = { "": release };
  for (const [name, { directory, manifest }] of staged) {
    packages[directory] = manifestEntry(manifest);
    packages[`node_modules/${name}`] = { resolved: directory, link: true };
  }

  const queue = [];
  const states = new Map();
  const edges = [];
  function enqueueDependencies(from, entry, optional, reviewedEntry = entry) {
    const regular = { ...entry.dependencies, ...entry.optionalDependencies };
    const names = new Set([
      ...Object.keys(regular),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    for (const name of [...names].sort()) {
      const peer = !Object.hasOwn(regular, name);
      const spec = peer ? entry.peerDependencies[name] : regular[name];
      if (!/^(@[^/]+\/)?[^/@.][^/]*$/.test(name) || typeof spec !== "string") {
        throw new Error(`Invalid dependency at ${from || "root"}: ${name}`);
      }
      const workspace = staged.get(name);
      if (workspaceNames.has(name) && !workspace) {
        throw new Error(
          `Runtime dependency requires an unstaged workspace: ${name} from ${from || "root"}`,
        );
      }
      if (workspace) {
        if (spec !== workspace.manifest.version) {
          throw new Error(
            `Workspace dependency must use the staged version: ${name}@${spec}`,
          );
        }
      } else if (reviewedEntry !== entry) {
        const reviewedSpec = peer
          ? reviewedEntry.peerDependencies?.[name]
          : {
              ...reviewedEntry.dependencies,
              ...reviewedEntry.optionalDependencies,
            }[name];
        if (spec !== reviewedSpec) {
          throw new Error(
            `External dependency differs from the reviewed manifest: ${from}: ${name}@${spec}`,
          );
        }
      }
      const peerFrom =
        peer && from.includes("node_modules/")
          ? from.slice(0, from.lastIndexOf("node_modules/")).replace(/\/$/, "")
          : from;
      const resolved = resolveDependency(source, peerFrom, name);
      if (
        !resolved &&
        peer &&
        entry.peerDependenciesMeta?.[name]?.optional &&
        !workspace
      )
        continue;
      if (!resolved)
        throw new Error(
          `Missing reviewed dependency: ${name} from ${from || "root"}`,
        );
      const target = workspace ? workspace.directory : resolved;
      if (workspace) {
        if (!source[resolved].link || source[resolved].resolved !== target) {
          throw new Error(
            `Reviewed resolution shadows staged workspace: ${name} from ${from || "root"}`,
          );
        }
      } else if (source[resolved].link) {
        throw new Error(`Dependency links to an unstaged package: ${resolved}`);
      }
      edges.push({ from: peerFrom, name, target });
      queue.push({
        path: target,
        optional:
          optional || Object.hasOwn(entry.optionalDependencies ?? {}, name),
      });
    }
  }

  // npm installs every declared workspace, even when the root has no dependency on that workspace.
  for (const { directory } of staged.values())
    queue.push({ path: directory, optional: false });
  enqueueDependencies("", release, false);
  for (let index = 0; index < queue.length; index++) {
    const { path, optional } = queue[index];
    if (states.has(path) && (!states.get(path) || optional)) continue;
    states.set(path, optional);
    if (directories.has(path)) {
      enqueueDependencies(path, packages[path], optional, source[path]);
      continue;
    }
    if (
      !path.startsWith("node_modules/") &&
      ![...directories].some((directory) =>
        path.startsWith(`${directory}/node_modules/`),
      )
    ) {
      throw new Error(
        `Dependency location lies outside the staged workspace tree: ${path}`,
      );
    }
    const original = source[path];
    if (
      !original?.version ||
      !original.resolved ||
      !original.integrity ||
      original.link
    ) {
      throw new Error(
        `External package lacks reviewed version, resolution, or integrity: ${path}`,
      );
    }
    if (!/^https:\/\//.test(original.resolved)) {
      throw new Error(
        `Unsupported external package resolution: ${path}: ${original.resolved}`,
      );
    }
    const copied = { ...original };
    delete copied.dev;
    delete copied.devOptional;
    delete copied.extraneous;
    delete copied.optional;
    if (optional) copied.optional = true;
    packages[path] = copied;
    enqueueDependencies(path, original, optional);
  }
  for (const { from, name, target } of edges) {
    const resolved = resolveDependency(packages, from, name);
    const actual = packages[resolved]?.link
      ? packages[resolved].resolved
      : resolved;
    if (actual !== target)
      throw new Error(
        `Release resolution changed for ${name} from ${from || "root"}`,
      );
  }
  // Overrides stay in package.json. npm does not serialize overrides into the root lock entry.
  if (
    rootManifest.overrides !== undefined &&
    (!rootManifest.overrides || typeof rootManifest.overrides !== "object")
  ) {
    throw new Error("The release overrides must be an object");
  }
  return sorted({
    name: release.name,
    version: release.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  });
}
