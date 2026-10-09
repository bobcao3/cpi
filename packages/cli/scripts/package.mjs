#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { version as esbuildVersion } from "esbuild";
import { init } from "es-module-lexer";
import { emitDeclarations } from "./release-declarations.mjs";
import { createReleaseLock } from "./release-lock.mjs";
import { bundleGhostmux, archiveRelease } from "./release-archive.mjs";
import { prepareReleaseSources } from "./release-sources.mjs";
import { stage_wasm } from "@cpi/tree-sitter-wasm/package";
import { resolveTreeSitterWasm } from "@cpi/tree-sitter-wasm/resolve";

import {
  inside,
  json,
  limits,
  manifestPaths,
  saveJson,
  stageTree,
  validateTree,
} from "./release-stage.mjs";

process.umask(0o022);
const checkout = await realpath(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
);
let root = checkout;
let snapshot;
async function main() {
  if (process.argv.length !== 3 || process.argv[2].startsWith("-"))
    throw new Error(
      "Usage: node packages/cli/scripts/package.mjs NEW_DESTINATION",
    );
  if (process.platform === "win32")
    throw new Error("Release staging currently requires a POSIX build host");
  const requested = resolve(process.argv[2]);
  const destination = join(
    await realpath(dirname(requested)),
    requested.slice(dirname(requested).length + 1),
  );
  if (inside(root, destination) || inside(destination, root))
    throw new Error("Destination must not overlap the source repository");
  try {
    await lstat(destination);
    throw new Error(`Destination already exists: ${destination}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const revision = spawnSync(
    "jj",
    ["log", "--no-graph", "-r", "@", "-T", "commit_id"],
    { cwd: checkout, encoding: "utf8", timeout: 5000, maxBuffer: 65536 },
  );
  const fallback =
    revision.status === 0
      ? revision
      : spawnSync("git", ["rev-parse", "HEAD"], {
          cwd: checkout,
          encoding: "utf8",
          timeout: 5000,
        });
  if (fallback.status !== 0)
    throw new Error("Release sources require JJ or Git revision provenance");
  snapshot = await prepareReleaseSources(checkout, dirname(destination));
  root = snapshot.root;
  const fork = await json(join(root, "vendor/pi/manifest.json"));
  const forkPins = new Map(
    fork.artifacts.map((artifact) => [artifact.name, artifact.url]),
  );
  const workspaces = new Map();
  for (const directory of [
    "packages/cli",
    "packages/harness",
    "packages/ghostmux",
    "packages/tree-sitter-wasm",
  ]) {
    const folder = join(root, directory);
    const manifest = await json(join(folder, "package.json"));
    if (workspaces.has(manifest.name))
      throw new Error(`Duplicate workspace name: ${manifest.name}`);
    workspaces.set(manifest.name, { folder, original: directory, manifest });
  }
  const selected = new Map();
  const queue = ["@cpi/cli"];
  for (const name of queue) {
    if (selected.has(name)) continue;
    const workspace = workspaces.get(name);
    if (!workspace) throw new Error(`Missing local runtime workspace: ${name}`);
    selected.set(name, workspace);
    for (const [dependency, version] of Object.entries({
      ...workspace.manifest.dependencies,
      ...workspace.manifest.optionalDependencies,
    })) {
      if (workspaces.has(dependency)) queue.push(dependency);
      else if (
        !/^(?:npm:@[^/]+\/[^@]+@)?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version) &&
        version !== forkPins.get(dependency)
      )
        throw new Error(
          `External runtime dependency must be exact: ${name}: ${dependency}@${version}`,
        );
    }
  }
  for (const { manifest } of selected.values()) {
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (workspaces.has(peer) && !selected.has(peer))
        throw new Error(`Host peer is absent from runtime closure: ${peer}`);
    }
  }
  await init;
  const declarations = await emitDeclarations(root, [selected.get("@cpi/cli")]);
  await mkdir(destination);
  console.log(`Staging release: ${destination}`);
  try {
    for (const workspace of selected.values()) {
      workspace.staged = join(destination, workspace.original);
      await mkdir(workspace.staged, { recursive: true });
      const allowedRoot = new Set([
        "README.md",
        "LICENSE",
        ...(workspace.manifest.files ?? ["src"])
          .filter((path) => !path.startsWith("!"))
          .map((path) =>
            path.split("/")[0] === "dist" ? "src" : path.split("/")[0],
          ),
      ]);
      await stageTree(
        workspace.folder,
        workspace.staged,
        workspace.folder,
        "",
        allowedRoot,
      );
      const headers = declarations.get(workspace.manifest.name);
      if (headers)
        await cp(headers, join(workspace.staged, "dist"), {
          recursive: true,
          filter: async (path) =>
            (await lstat(path)).isDirectory() ||
            /\.d\.(ts|mts|cts)$/.test(path),
        });
      const manifest = structuredClone(workspace.manifest);
      delete manifest.devDependencies;
      delete manifest.scripts;
      delete manifest.workspaces;
      for (const key of ["exports", "main", "module", "bin", "pi", "files"]) {
        if (manifest[key]) manifest[key] = manifestPaths(manifest[key]);
      }
      for (const field of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
      ]) {
        for (const name of Object.keys(manifest[field] ?? {})) {
          if (selected.has(name))
            manifest[field][name] = selected.get(name).manifest.version;
        }
      }
      manifest.private = true;
      workspace.installedManifest = manifest;
      await saveJson(join(workspace.staged, "package.json"), manifest);
      try {
        await lstat(join(workspace.staged, "LICENSE"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await copyFile(
          join(root, "LICENSE"),
          join(workspace.staged, "LICENSE"),
        );
      }
    }
    const sourceManifest = await json(join(root, "package.json"));
    const sourceLock = await json(join(root, "package-lock.json"));
    for (const artifact of fork.artifacts) {
      const installed = await json(
        join(root, "node_modules", artifact.name, "package.json"),
      );
      const entries = Object.entries(sourceLock.packages).filter(([path]) =>
        path.endsWith(`node_modules/${artifact.name}`),
      );
      if (
        entries.length !== 1 ||
        entries[0][1].version !== artifact.version ||
        (entries[0][1].name ?? artifact.name) !== artifact.name ||
        entries[0][1].integrity !== artifact.integrity ||
        entries[0][1].resolved !== artifact.url ||
        sourceManifest.dependencies[artifact.name] !== artifact.url ||
        installed.name !== artifact.name ||
        installed.version !== artifact.version
      )
        throw new Error(`Mixed or unpinned fork graph: ${artifact.name}`);
    }
    const manifest = {
      name: "cpi-release",
      version: selected.get("@cpi/cli").manifest.version,
      private: true,
      type: "module",
      workspaces: [...selected.values()].map((workspace) => workspace.original),
      dependencies: {
        ...sourceManifest.dependencies,
        "@cpi/cli": selected.get("@cpi/cli").manifest.version,
      },
      overrides: Object.fromEntries(
        Object.entries(sourceManifest.overrides ?? {}).map(([name, spec]) => [
          name,
          typeof spec === "string" && spec.startsWith("$")
            ? (sourceManifest.dependencies?.[spec.slice(1)] ??
              sourceManifest.devDependencies?.[spec.slice(1)])
            : spec,
        ]),
      ),
    };
    await saveJson(join(destination, "package.json"), manifest);
    const reviewedLock = await readFile(join(root, "package-lock.json"));
    await saveJson(
      join(destination, "package-lock.json"),
      createReleaseLock(
        JSON.parse(reviewedLock),
        manifest,
        [...selected.values()].map((workspace) => ({
          directory: workspace.original,
          manifest: workspace.installedManifest,
        })),
      ),
    );
    await writeFile(join(destination, ".npm-globalrc"), "");
    const env = {
      ...process.env,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      npm_config_ignore_scripts: "true",
      npm_config_userconfig: "/dev/null",
      npm_config_globalconfig: join(destination, ".npm-globalrc"),
    };
    const result = spawnSync(
      "npm",
      ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"],
      {
        cwd: destination,
        stdio: "inherit",
        timeout: limits.installMs,
        killSignal: "SIGKILL",
        env,
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        `npm install failed: ${result.error?.message ?? result.status}`,
      );
    for (const artifact of fork.artifacts) {
      const path = join(
        destination,
        "node_modules",
        artifact.name,
        "package.json",
      );
      const installed = await json(path);
      installed.cpiFork = {
        repository: "https://github.com/bobcao3/pi",
        revision: fork.forkRevision,
        upstreamRevision: fork.upstreamRevision,
        integrity: artifact.integrity,
      };
      await saveJson(path, installed);
    }
    for (const name of ["@cpi/ghostmux", "@cpi/tree-sitter-wasm"])
      await rm(selected.get(name).staged, { recursive: true });
    const native = await bundleGhostmux(selected.get("@cpi/ghostmux").staged);
    await stage_wasm(
      selected.get("@cpi/tree-sitter-wasm").staged,
      await resolveTreeSitterWasm(),
    );
    for (const [name, workspace] of selected) {
      const target = join(destination, "node_modules", name);
      if (
        !(await lstat(target)).isSymbolicLink() ||
        (await realpath(target)) !== (await realpath(workspace.staged))
      ) {
        throw new Error(`npm did not link the local workspace: ${name}`);
      }
      await rm(target);
      await rename(workspace.staged, target);
    }
    await rm(join(destination, "packages"), { recursive: true });
    await rm(join(destination, "node_modules", ".package-lock.json"), {
      force: true,
    });
    delete manifest.workspaces;
    await saveJson(join(destination, "package.json"), manifest);
    const binDir = join(destination, "node_modules", ".bin");
    await mkdir(binDir, { recursive: true });
    const bins = new Set();
    for (const [name, workspace] of selected) {
      const entries =
        typeof workspace.installedManifest.bin === "string"
          ? { [name.split("/").at(-1)]: workspace.installedManifest.bin }
          : (workspace.installedManifest.bin ?? {});
      for (const [bin, path] of Object.entries(entries)) {
        if (bins.has(bin) || bin.includes("/") || bin === "..")
          throw new Error(`Invalid or duplicate bin: ${bin}`);
        bins.add(bin);
        const target = resolve(destination, "node_modules", name, path);
        if (!inside(join(destination, "node_modules", name), target))
          throw new Error(`Bin escapes package: ${bin}`);
        await chmod(target, 0o755);
        await rm(join(binDir, bin), { force: true });
        await symlink(relative(binDir, target), join(binDir, bin));
      }
    }
    await validateTree(destination, destination, new Set(selected.keys()));
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    await archiveRelease(
      destination,
      [...selected.values()],
      {
        node: process.version,
        esbuild: esbuildVersion,
        sourceRevision: fallback.stdout.trim(),
        fork: await json(join(root, "vendor/pi/manifest.json")),
        typescript: (
          await json(join(root, "node_modules/typescript/package.json"))
        ).version,
        rootLockSha256: sha256(reviewedLock),
        runtimeLockSha256: sha256(
          await readFile(join(destination, "package-lock.json")),
        ),
        native,
        lifecycleScripts: false,
      },
      env,
    );
  } catch (error) {
    console.error(
      `Incomplete artifact retained for inspection: ${destination}`,
    );
    throw error;
  }
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (snapshot) await rm(snapshot.root, { recursive: true, force: true });
  });
