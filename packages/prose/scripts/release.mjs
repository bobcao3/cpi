import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { list } from "tar";
import { archive_manifest } from "../../cli/scripts/registry-archive.mjs";
import { registry_repository } from "../../cli/scripts/registry-manifest.mjs";

export const names = ["@bobcao3/cpi-tree-sitter-wasm", "@bobcao3/cpi-prose"];
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export const integrity = (bytes) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const json = async (path) => JSON.parse(await readFile(path, "utf8"));

export function release_tag(version) {
  const explicit = process.env.CPI_PROSE_RELEASE_TAG || undefined;
  const github =
    process.env.GITHUB_REF_TYPE === "tag"
      ? process.env.GITHUB_REF_NAME
      : undefined;
  if (explicit && github) assert.equal(explicit, github);
  const tag = explicit ?? github ?? null;
  if (tag !== null) {
    assert.match(tag, /^prose-v\d+\.\d+\.\d+$/);
    assert.equal(
      tag,
      `prose-v${version}`,
      "Prose tag must match the source version",
    );
  }
  return tag;
}

export function execute(
  command,
  args,
  { cwd, env = process.env, timeout = 120000 } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      failure;
    const terminate = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") failure = error;
      }
    };
    const timer = setTimeout(() => {
      failure = new Error(`${command} exceeded ${timeout}ms`);
      terminate();
    }, timeout);
    const interrupted = () => {
      failure = new Error("Release command interrupted");
      terminate();
    };
    process.once("SIGINT", interrupted);
    process.once("SIGTERM", interrupted);
    for (const [stream, append] of [
      [
        child.stdout,
        (text) => {
          stdout += text;
        },
      ],
      [
        child.stderr,
        (text) => {
          stderr += text;
        },
      ],
    ])
      stream.on("data", (bytes) => {
        append(bytes.toString());
        if (stdout.length + stderr.length > 8 * 1024 * 1024) {
          failure = new Error("Command output exceeded its limit");
          terminate();
        }
      });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      process.removeListener("SIGINT", interrupted);
      process.removeListener("SIGTERM", interrupted);
      if (failure || code !== 0)
        reject(
          new Error(`${command} ${args.join(" ")}\n${stdout}\n${stderr}`, {
            cause: failure ?? new Error(`Exit ${code}`),
          }),
        );
      else resolve(stdout);
    });
  });
}

export async function validate(directory) {
  const metadata = await readFile(join(directory, "packages.json"));
  assert(metadata.length < 1024 * 1024);
  const packages = JSON.parse(metadata);
  assert.deepEqual(
    packages.map((pkg) => pkg.name),
    names,
    "Publish WASM before prose",
  );
  assert.equal(packages[0].version, packages[1].version);
  for (const pkg of packages) {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
    assert.match(pkg.filename, /^[\w.-]+\.tgz$/);
    assert.match(pkg.source.revision, /^[a-f0-9]{40}$/);
    assert.equal(pkg.source.repository, registry_repository);
    assert(
      pkg.source.tag === null || pkg.source.tag === `prose-v${pkg.version}`,
    );
    assert.deepEqual(pkg.source, packages[0].source);
    const archive = join(directory, pkg.filename);
    assert((await stat(archive)).size <= 64 * 1024 * 1024);
    const bytes = await readFile(archive);
    assert.equal(digest(bytes), pkg.sha256);
    assert.equal(integrity(bytes), pkg.integrity);
    const paths = new Set();
    let expanded = 0;
    await list({
      file: archive,
      onReadEntry(entry) {
        assert(
          paths.size < 10000 && (expanded += entry.size) < 256 * 1024 * 1024,
        );
        assert(["File", "Directory"].includes(entry.type));
        assert(
          entry.path.startsWith("package/") &&
            !entry.path.split("/").includes("..") &&
            !entry.path.includes("\\"),
        );
        assert(
          !paths.has(entry.path),
          `Duplicate archive entry: ${entry.path}`,
        );
        paths.add(entry.path);
        assert(
          !/(?:^|\/)(?:node_modules|\.venv|__pycache__)(?:\/|$)/.test(
            entry.path,
          ),
        );
      },
    });
    const manifest = await archive_manifest(archive);
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(manifest.scripts, undefined);
    assert.equal(manifest.private, undefined);
    assert.equal(manifest.devDependencies, undefined);
    assert.equal(manifest.peerDependencies, undefined);
    assert.equal(manifest.repository?.url, registry_repository);
    if (pkg.name === names[1]) {
      assert.deepEqual(manifest.dependencies, {
        "@cpi/tree-sitter-wasm": `npm:${names[0]}@${pkg.version}`,
      });
      assert.equal(
        manifest.bin?.["cpi-prose"]?.replace(/^\.\//, ""),
        "bin/cpi-prose.mjs",
      );
      for (const path of [
        "bin/cpi-prose.mjs",
        "src/cli.mjs",
        "src/cpi_prose/bridge.py",
        "src/textdescriptives/__init__.py",
        "pyproject.toml",
        "uv.lock",
        ".python-version",
      ])
        assert(
          paths.has(`package/${path}`),
          `Missing packaged runtime: ${path}`,
        );
    } else {
      assert.equal(manifest.dependencies, undefined);
      for (const path of [
        "index.mjs",
        "resolve.mjs",
        "assets/tree-sitter-wasm.wasm",
        "assets/tree-sitter-wasm.wasm.minisig",
      ])
        assert(paths.has(`package/${path}`), `Missing packaged WASM: ${path}`);
    }
  }
  assert.equal(
    await readFile(join(directory, "SHA256SUMS"), "utf8"),
    packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}\n`).join(""),
  );
  return { packages, packagesSha256: digest(metadata) };
}

export async function public_version(pkg) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(pkg.name)}/${pkg.version}`,
    { signal: AbortSignal.timeout(30000) },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  assert(response.ok, `${pkg.name}: HTTP ${response.status}`);
  const manifest = await response.json();
  assert.equal(
    manifest.dist?.integrity,
    pkg.integrity,
    `Published bytes differ: ${pkg.name}@${pkg.version}; bump the version`,
  );
  return manifest;
}
