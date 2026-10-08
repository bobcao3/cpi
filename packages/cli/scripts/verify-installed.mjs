import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyReleaseLock } from "./verify-lock.mjs";
import { verifyPiGraph } from "./verify-pi-graph.mjs";

assert(
  process.argv.length === 3 ||
    (process.argv.length === 4 && process.argv[3] === "--tui"),
  "Usage: node packages/cli/scripts/verify-installed.mjs ARTIFACT [--tui]",
);
const destination = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, "../../extensions/scripts");
const metadata = JSON.parse(
  await readFile(join(destination, "release-manifest.json"), "utf8"),
);
await verifyReleaseLock(resolve(here, "../../.."), destination, metadata);
assert.equal(metadata.filename, metadata.filename.split(/[\\/]/).at(-1));
const tarball = join(destination, metadata.filename);
assert.equal(
  createHash("sha256")
    .update(await readFile(tarball))
    .digest("hex"),
  metadata.sha256,
);
const cache = join(homedir(), ".cache/cpi-migration-verification");
await mkdir(cache, { recursive: true });
const consumer = await mkdtemp(join(cache, "cpi-release-consumer-"));
await writeFile(
  join(consumer, "package.json"),
  '{"private":true,"type":"module"}\n',
);
await mkdir(join(consumer, "home"));
await writeFile(join(consumer, "home/.zshrc"), "");
const env = {
  ...process.env,
  HOME: join(consumer, "home"),
  XDG_CACHE_HOME: join(consumer, "cache"),
  npm_config_cache: join(consumer, "npm-cache"),
  NODE_OPTIONS: "",
  NODE_PATH: "",
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
};
for (const key of Object.keys(env)) {
  if (key.startsWith("CPI_") || key.startsWith("PI_")) delete env[key];
}
Object.assign(env, {
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  XDG_CONFIG_HOME: join(consumer, "config"),
});
function execute(
  command,
  args,
  cwd = consumer,
  expected = 0,
  environment = env,
) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  assert.ifError(result.error);
  assert.equal(result.status, expected, `Failed: ${args.join(" ")}`);
  return result.stdout + result.stderr;
}
execute("npm", [
  "install",
  "--offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=http://127.0.0.1:9",
  tarball,
]);
const prefix = join(consumer, "global");
execute("npm", [
  "install",
  "--global",
  "--prefix",
  prefix,
  "--offline",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
  "--registry=http://127.0.0.1:9",
  tarball,
]);
execute(join(prefix, "bin/cpi"), ["--version"]);
const bunAvailable =
  spawnSync("bun", ["--version"], { env, encoding: "utf8", timeout: 5000 })
    .status === 0;
let bunError;
const verifyBun = async () => {
  if (bunAvailable) {
    const bunPrefix = join(consumer, "bun-global");
    const bunEnv = {
      ...env,
      BUN_INSTALL_GLOBAL_DIR: join(bunPrefix, "global"),
      BUN_INSTALL_BIN: join(bunPrefix, "bin"),
      BUN_INSTALL_CACHE_DIR: join(bunPrefix, "cache"),
    };
    await mkdir(bunEnv.BUN_INSTALL_GLOBAL_DIR, { recursive: true });
    await writeFile(
      join(bunEnv.BUN_INSTALL_GLOBAL_DIR, "package.json"),
      '{"private":true}\n',
    );
    execute(
      "bun",
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--registry=http://127.0.0.1:9",
        tarball,
      ],
      consumer,
      0,
      bunEnv,
    );
    const bunInstalled = join(bunPrefix, "global/node_modules/@cpi/cli");
    assert.equal(
      await realpath(join(bunPrefix, "bin/cpi")),
      join(bunInstalled, "bin/cpi"),
    );
    execute(join(bunPrefix, "bin/cpi"), ["--version"], consumer, 0, bunEnv);
    execute(join(bunPrefix, "bin/cpi"), ["--help"], consumer, 0, bunEnv);
    await verifyPiGraph(bunInstalled, metadata.fork.artifacts);
    await copyFile(
      join(here, "installed-native-probe.mjs"),
      join(bunInstalled, "native-probe.mjs"),
    );
    execute(
      "bun",
      ["--bun", join(bunInstalled, "native-probe.mjs")],
      consumer,
      0,
      bunEnv,
    );
    const bunExtensions = join(bunInstalled, "node_modules/@cpi/extensions");
    await cp(scripts, join(bunExtensions, "scripts"), { recursive: true });
    for (const name of [
      "codemode-render.integration.mjs",
      "tool-tree.integration.mjs",
      "footer-layout.integration.mjs",
      ...(process.argv[3] === "--tui"
        ? ["tui.integration.mjs", "object-tree.integration.mjs"]
        : []),
    ])
      execute(
        "bun",
        ["--bun", join(bunExtensions, "scripts", name)],
        bunExtensions,
        0,
        bunEnv,
      );
  } else {
    console.log(
      "Bun is unavailable; skipping the Bun global-install smoke test.",
    );
  }
};
const installed = join(consumer, "node_modules/@cpi/cli");
await verifyPiGraph(installed, metadata.fork.artifacts);
await copyFile(
  join(here, "installed-native-probe.mjs"),
  join(installed, "native-probe.mjs"),
);
execute(process.execPath, [join(installed, "native-probe.mjs")]);
const extensions = join(installed, "node_modules/@cpi/extensions");
for (const { name } of metadata.workspacePackages)
  assert(
    !(
      await lstat(
        name === "@cpi/cli" ? installed : join(installed, "node_modules", name),
      )
    ).isSymbolicLink(),
  );
await assert.rejects(lstat(join(extensions, "node_modules/@earendil-works")), {
  code: "ENOENT",
});
const run = (args, expected = 0) =>
  execute(process.execPath, args, extensions, expected);
const app = join(installed, "bin/cpi");
execute(app, ["--version"], extensions);
execute(app, ["--help"], extensions);
execute(app, ["--list-models"], extensions);
run([
  join(installed, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "--version",
]);
assert.match(
  execute(app, ["update", "--self"], extensions, 1),
  /Self-update is disabled/,
);
await mkdir(join(consumer, "node_modules/@types"), { recursive: true });
await cp(
  join(installed, "node_modules/@types/node"),
  join(consumer, "node_modules/@types/node"),
  { recursive: true },
);
await cp(
  join(installed, "node_modules/undici-types"),
  join(consumer, "node_modules/undici-types"),
  { recursive: true },
);
await copyFile(
  join(here, "consumer-types.mts"),
  join(consumer, "consumer.mts"),
);
execute(process.execPath, [
  resolve(here, "../../../node_modules/typescript/bin/tsc"),
  "--noEmit",
  "--strict",
  "--skipLibCheck",
  "false",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  "--target",
  "ES2024",
  "consumer.mts",
]);
const scripts = join(extensions, "scripts");
await mkdir(scripts, { recursive: true });
for (const name of [
  "codemode-render.integration.mjs",
  "codemode-render-probe.mjs",
  "codemode-render-context.mjs",
  "shell-platform.mjs",
  "structured-output-fixture.mjs",
  "tool-tree.integration.mjs",
  "tool-tree-mcp-fixture.mjs",
  "fast-fixture.mjs",
  "test-runtime.mjs",
  "loopback-network.mjs",
  "fast-host-fixture.mjs",
  "fast-startup.test.mjs",
  "subagent-install.test.mjs",
  "tui.integration.mjs",
  "footer-layout.integration.mjs",
  "object-tree.integration.mjs",
  "migration-visual.integration.mjs",
]) {
  const text = (await readFile(join(source, name), "utf8")).replace(
    /\.ts(["'])/g,
    ".js$1",
  );
  await writeFile(join(scripts, name), text);
}
run([join(scripts, "codemode-render.integration.mjs")]);
run([join(scripts, "tool-tree.integration.mjs")]);
run([join(scripts, "footer-layout.integration.mjs")]);
run([
  "--test",
  join(scripts, "fast-startup.test.mjs"),
  join(scripts, "subagent-install.test.mjs"),
]);
if (process.argv[3] === "--tui") {
  run([join(scripts, "tui.integration.mjs")]);
  run([join(scripts, "object-tree.integration.mjs")]);
}
await writeFile(join(destination, "consumer-path.txt"), `${consumer}\n`);
console.log(
  `Npm passed offline installation, strict SDK typechecking, tools, reload, CLI, and isolated workers. Consumer: ${consumer}`,
);
try {
  await verifyBun();
} catch (error) {
  bunError = error;
  console.error(`Bun verification failed separately: ${error.message}`);
}
await writeFile(
  join(destination, "verification.json"),
  `${JSON.stringify({ npm: "passed", bun: bunError ? "failed" : bunAvailable ? "passed" : "unavailable", bunError: bunError?.message, consumer }, null, 2)}\n`,
);
if (bunError) process.exitCode = 1;
