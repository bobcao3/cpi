import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const spec = process.argv[2];
assert(
  spec && process.argv.length === 3,
  "Usage: verify-github.mjs PACKAGE_SPEC",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const work = await mkdtemp(join(tmpdir(), "cpi-github-consumer-"));
for (const manager of ["npm", "bun"]) {
  const prefix = join(work, manager);
  const home = join(prefix, "home");
  await mkdir(home, { recursive: true });
  await writeFile(join(home, ".zshrc"), "");
  await writeFile(join(prefix, "npmrc"), "");
  const env = {
    ...process.env,
    HOME: home,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    XDG_CONFIG_HOME: join(prefix, "config"),
    XDG_CACHE_HOME: join(prefix, "cache"),
    npm_config_cache: join(prefix, "npm-cache"),
    npm_config_userconfig: join(prefix, "npmrc"),
    npm_config_ignore_scripts: "true",
    BUN_INSTALL_GLOBAL_DIR: join(prefix, "global"),
    BUN_INSTALL_BIN: join(prefix, "bin"),
    BUN_INSTALL_CACHE_DIR: join(prefix, "bun-cache"),
  };
  for (const key of Object.keys(env))
    if (
      /^(?:CPI_|PI_|GHOSTMUX_|NPM_CONFIG_|NODE_AUTH_TOKEN$|NPM_TOKEN$)/.test(
        key,
      )
    )
      delete env[key];
  env.PI_OFFLINE = "1";
  env.PI_SKIP_VERSION_CHECK = "1";
  function execute(command, args) {
    const result = spawnSync(command, args, {
      cwd: home,
      env,
      encoding: "utf8",
      timeout: 300000,
      maxBuffer: 8 * 1024 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return result.stdout;
  }
  console.log(`Installing ${spec} with ${manager}, scripts disabled...`);
  const args = ["install", "--global", "--ignore-scripts", spec];
  if (manager === "npm")
    args.push("--prefix", prefix, "--no-audit", "--no-fund");
  console.log(execute(manager, args));
  const installed = join(
    prefix,
    manager === "npm" ? "lib/node_modules/cpi" : "global/node_modules/cpi",
  );
  const cli = join(installed, "packages/cli");
  const manifest = JSON.parse(
    await readFile(join(cli, "package.json"), "utf8"),
  );
  const launcher = join(prefix, "bin/cpi");
  assert.equal(execute(launcher, ["--version"]).trim(), manifest.version);
  execute(launcher, ["--help"]);
  const probe = join(cli, "github-probe.mjs");
  await copyFile(join(root, "packages/cli/scripts/registry-probe.mjs"), probe);
  console.log(
    execute(manager === "npm" ? process.execPath : "bun", [
      ...(manager === "bun" ? ["--bun"] : []),
      probe,
      cli,
    ]),
  );
}
console.log(`GitHub source installations passed. Isolated consumers: ${work}`);
