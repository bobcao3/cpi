import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { registry_server } from "./registry-server.mjs";
import { archive_manifest } from "./registry-archive.mjs";

assert.equal(
  process.argv.length,
  3,
  "Usage: verify-registry.mjs PACKAGE_DIRECTORY",
);
const directory = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const packages = JSON.parse(
  await readFile(join(directory, "packages.json"), "utf8"),
);
for (const pkg of packages) {
  assert.equal(
    createHash("sha256")
      .update(await readFile(join(directory, pkg.filename)))
      .digest("hex"),
    pkg.sha256,
  );
  const manifest = await archive_manifest(join(directory, pkg.filename));
  assert.equal(manifest.name, pkg.name);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.scripts, undefined);
  assert.equal(manifest.private, undefined);
  assert(
    !JSON.stringify(manifest.dependencies ?? {}).includes(
      "https://github.com/",
    ),
  );
}
const consumer = await mkdtemp(join(tmpdir(), "cpi-registry-consumer-"));
const server = await registry_server(directory, packages);
const cli = packages.find((pkg) => pkg.name === "@bobcao3/cpi");
async function execute(command, args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      cwd,
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (bytes) => {
        output += bytes;
        if (output.length > 16 * 1024 * 1024) child.kill();
      });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${command} ${args.join(" ")}\n${output}`)),
    );
  });
}
try {
  for (const manager of ["npm", "bun"]) {
    const prefix = join(consumer, manager);
    const home = join(prefix, "home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, ".zshrc"), "");
    await writeFile(join(prefix, "npmrc"), "");
    await writeFile(join(prefix, "npm-globalrc"), "");
    const env = {
      ...process.env,
      HOME: home,
      NODE_OPTIONS: "",
      NODE_PATH: "",
      XDG_CONFIG_HOME: join(prefix, "config"),
      XDG_CACHE_HOME: join(prefix, "cache"),
      npm_config_cache: join(prefix, "npm-cache"),
      npm_config_userconfig: join(prefix, "npmrc"),
      npm_config_globalconfig: join(prefix, "npm-globalrc"),
      npm_config_ignore_scripts: "true",
      BUN_INSTALL_GLOBAL_DIR: join(prefix, "global"),
      BUN_INSTALL_BIN: join(prefix, "bin"),
      BUN_INSTALL_CACHE_DIR: join(prefix, "bun-cache"),
    };
    for (const key of Object.keys(env))
      if (/^(?:CPI_|PI_|GHOSTMUX_)/.test(key)) delete env[key];
    env.PI_OFFLINE = "1";
    env.PI_SKIP_VERSION_CHECK = "1";
    const args = [
      "install",
      "--global",
      "--ignore-scripts",
      `${cli.name}@${cli.version}`,
      "--registry",
      server.url,
    ];
    if (manager === "npm")
      args.push(
        "--prefix",
        prefix,
        "--no-audit",
        "--no-fund",
        "--fetch-retries=0",
      );
    console.log(
      `Installing ${cli.name}@${cli.version} by registry name with ${manager}, scripts disabled...`,
    );
    console.log(await execute(manager, args, env, home));
    const installed = join(
      prefix,
      manager === "npm" ? "lib/node_modules" : "global/node_modules",
      cli.name,
    );
    const command = join(prefix, "bin/cpi");
    assert.equal(
      (await execute(command, ["--version"], env, home)).trim(),
      cli.version,
    );
    await execute(command, ["--help"], env, home);
    const probe = join(installed, "registry-probe.mjs");
    await copyFile(join(here, "registry-probe.mjs"), probe);
    console.log(
      await execute(
        manager === "npm" ? process.execPath : "bun",
        [...(manager === "bun" ? ["--bun"] : []), probe, installed],
        env,
        home,
      ),
    );
  }
  assert(
    !server.requests.some(
      (name) => name.startsWith("@earendil-works/") || name.startsWith("@cpi/"),
    ),
    "An internal dependency escaped its exact registry alias",
  );
  await writeFile(
    join(directory, "registry-verification.json"),
    `${JSON.stringify(
      {
        package: cli.name,
        version: cli.version,
        platform: process.platform,
        arch: process.arch,
        managers: ["npm", "bun"],
        lifecycleScripts: false,
        consumer,
        packagesSha256: createHash("sha256")
          .update(await readFile(join(directory, "packages.json")))
          .digest("hex"),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Registry installs passed. Isolated consumers retained at ${consumer}`,
  );
} finally {
  await server.close();
}
