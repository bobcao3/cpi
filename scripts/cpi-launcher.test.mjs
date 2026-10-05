import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const launcher = join(root, "packages/cli/bin/cpi");

function put(directory, path, content = "") {
  const target = join(directory, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "cpi global # % "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  put(directory, "home/.npmrc");
  put(directory, "npm-globalrc");
  put(directory, "project/bun.lock");
  put(directory, "project/deno.lock");
  const env = {
    ...process.env,
    HOME: join(directory, "home"),
    CPI_RUNTIME: "",
    NODE_OPTIONS: "",
    NODE_PATH: "",
    npm_config_cache: join(directory, "npm-cache"),
    npm_config_userconfig: join(directory, "home/.npmrc"),
    npm_config_globalconfig: join(directory, "npm-globalrc"),
    npm_config_ignore_scripts: "true",
  };
  return { directory, env, cwd: join(directory, "project") };
}

function execute(command, args, options) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: 30000,
    ...options,
  });
}

function installFixture(
  directory,
  packagePath = "install/node_modules/@cpi/cli",
) {
  const target = put(directory, `${packagePath}/bin/cpi`);
  copyFileSync(launcher, target);
  chmodSync(target, 0o755);
  return target;
}

function restrictedPath(directory) {
  const bin = join(directory, "tools");
  mkdirSync(bin);
  for (const utility of ["dirname", "readlink"]) {
    const found = execute("/bin/sh", ["-c", `command -v ${utility}`]);
    assert.equal(found.status, 0, found.stderr);
    symlinkSync(found.stdout.trim(), join(bin, utility));
  }
  return bin;
}

test("installed launcher selects the runtime without changing arguments, cwd, or Node options", async (t) => {
  for (const [markers, runtime, override] of [
    [[], "node"],
    [["install/node_modules/.package-lock.json"], "node"],
    [["install/bun.lock"], "bun"],
    [["install/bun.lockb"], "bun"],
    [["install/node_modules/.bun/marker"], "bun"],
    [["install/node_modules/.deno/marker"], "deno"],
    [["install/deno.lock"], "deno"],
    [["install/node_modules/.pnpm/marker", "install/bun.lock"], "node"],
    [["install/node_modules/.yarn-state.yml"], "node"],
    [["install/node_modules/.package-lock.json", "install/bun.lock"], "node"],
    [["install/node_modules/.package-lock.json"], "bun", "bun"],
  ]) {
    await t.test(
      `${runtime}: ${markers.join(", ") || "fallback"}${override ? " override" : ""}`,
      (t) => {
        const { directory, env, cwd } = fixture(t);
        for (const marker of markers) put(directory, marker);
        const target = installFixture(directory);
        const bin = restrictedPath(directory);
        const recorder = put(
          directory,
          "record.mjs",
          "console.log(JSON.stringify({runtime:process.argv[2],args:process.argv.slice(3),cwd:process.cwd(),options:process.env.NODE_OPTIONS})); process.exit(23);",
        );
        const shim = put(
          directory,
          `tools/${runtime}`,
          `#!/bin/sh\nexec '${process.execPath}' '${recorder}' '${runtime}' "$@"\n`,
        );
        chmodSync(shim, 0o755);
        symlinkSync(relative(bin, target), join(bin, "cpi-link"));
        symlinkSync("cpi-link", join(bin, "cpi"));
        const result = execute(
          "/bin/sh",
          ["-c", 'exec cpi "$@"', "sh", "--", "a b", "", "*.ts"],
          {
            cwd,
            env: {
              ...env,
              PATH: bin,
              CPI_RUNTIME: override ?? "",
              NODE_OPTIONS: "--no-warnings",
            },
          },
        );
        assert.equal(result.status, 23, result.stderr);
        const record = JSON.parse(result.stdout);
        assert.equal(record.runtime, runtime);
        assert.ok(record.args.includes(join(dirname(target), "cpi.mjs")));
        assert.deepEqual(record.args.slice(-4), ["--", "a b", "", "*.ts"]);
        assert.equal(record.cwd, cwd);
        assert.equal(record.options, "--no-warnings");
      },
    );
  }
});

test("launcher rejects invalid or unavailable runtimes", (t) => {
  const { directory, env, cwd } = fixture(t);
  const target = installFixture(directory);
  const PATH = restrictedPath(directory);
  for (const [CPI_RUNTIME, expected] of [
    ["invalid", 1],
    ["bun", 127],
  ]) {
    const result = execute(target, [], {
      cwd,
      env: { ...env, PATH, CPI_RUNTIME },
    });
    assert.equal(result.status, expected, result.stderr);
    assert.match(result.stderr, new RegExp(CPI_RUNTIME));
  }
});

function compiledEntry(directory, packagePath) {
  put(
    directory,
    `${packagePath}/bin/cpi.mjs`,
    '#!/usr/bin/env node\nimport "../dist/cli.js";\n',
  );
  put(
    directory,
    `${packagePath}/dist/cli.js`,
    'import process from "node:process"; console.log(JSON.stringify({runtime:process.versions.bun ? "bun" : globalThis.Deno ? "deno" : "node",args:process.argv.slice(2),cwd:process.cwd()}));\n',
  );
}

test("npm and Bun global installs execute the packaged POSIX launcher with their own runtime", async (t) => {
  const { directory, env, cwd } = fixture(t);
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/cli/package.json"), "utf8"),
  );
  installFixture(directory, "package");
  compiledEntry(directory, "package");
  put(
    directory,
    "package/package.json",
    JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      type: "module",
      bin: manifest.bin,
      files: ["bin", "dist"],
    }),
  );
  const packed = execute(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", directory],
    { cwd: join(directory, "package"), env },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = join(
    directory,
    Object.values(JSON.parse(packed.stdout))[0].filename,
  );
  for (const runtime of ["node", "bun"]) {
    const available = execute(runtime, ["--version"]).status === 0;
    await t.test(runtime, { skip: !available }, () => {
      const prefix = join(directory, runtime);
      const bin = join(prefix, "bin");
      const installEnv = {
        ...env,
        BUN_INSTALL_GLOBAL_DIR: join(prefix, "global"),
        BUN_INSTALL_BIN: bin,
        BUN_INSTALL_CACHE_DIR: join(prefix, "cache"),
      };
      const installed =
        runtime === "node"
          ? execute(
              "npm",
              [
                "install",
                "--global",
                "--prefix",
                prefix,
                "--offline",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                tarball,
              ],
              { cwd, env: installEnv },
            )
          : execute(
              "bun",
              ["install", "--global", "--ignore-scripts", tarball],
              { cwd, env: installEnv },
            );
      assert.equal(installed.status, 0, installed.stderr + installed.stdout);
      const result = execute(join(bin, "cpi"), ["--", "a b", "", "*.ts"], {
        cwd,
        env: installEnv,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        runtime,
        args: ["--", "a b", "", "*.ts"],
        cwd,
      });
    });
  }
});

test(
  "Bun's global development link runs checkout edits without packaging",
  { skip: execute("bun", ["--version"]).status !== 0 },
  (t) => {
    const { directory, env, cwd } = fixture(t);
    const packagePath = "checkout/packages/cli";
    installFixture(directory, packagePath);
    put(directory, `${packagePath}/bin/cpi.mjs`);
    copyFileSync(
      join(root, "packages/cli/bin/cpi.mjs"),
      join(directory, packagePath, "bin/cpi.mjs"),
    );
    const manifest = JSON.parse(
      readFileSync(join(root, "packages/cli/package.json"), "utf8"),
    );
    put(
      directory,
      `${packagePath}/package.json`,
      JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        type: "module",
        bin: manifest.bin,
      }),
    );
    put(
      directory,
      "checkout/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          paths: { "@earendil-works/example": ["./value.ts"] },
        },
      }),
    );
    put(
      directory,
      `${packagePath}/src/cli.ts`,
      'import {value} from "@earendil-works/example"; console.log(JSON.stringify({value, runtime:process.versions.bun ? "bun" : "node"}));',
    );
    const linkEnv = {
      ...env,
      BUN_INSTALL: join(env.HOME, ".bun"),
      BUN_INSTALL_GLOBAL_DIR: join(env.HOME, ".bun/install/global"),
      BUN_INSTALL_BIN: join(directory, "bin"),
    };
    const linked = execute("bun", ["link", "--ignore-scripts"], {
      cwd: join(directory, packagePath),
      env: linkEnv,
    });
    assert.equal(linked.status, 0, linked.stderr);
    const runEnv = { ...env };
    delete runEnv.BUN_INSTALL;
    delete runEnv.BUN_INSTALL_GLOBAL_DIR;
    for (const value of [7, 19]) {
      put(
        directory,
        "checkout/value.ts",
        `export const value: number = ${value};`,
      );
      const result = execute(join(directory, "bin/cpi"), [], {
        cwd,
        env: runEnv,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { value, runtime: "bun" });
    }
  },
);

test(
  "Deno launches the compiled package without source aliases",
  { skip: execute("deno", ["--version"]).status !== 0 },
  (t) => {
    const { directory, env, cwd } = fixture(t);
    const target = installFixture(directory);
    compiledEntry(directory, "install/node_modules/@cpi/cli");
    put(
      directory,
      "install/node_modules/@cpi/cli/package.json",
      '{"name":"@cpi/cli","type":"module"}',
    );
    put(directory, "install/node_modules/.deno/marker");
    const result = execute(target, ["a b"], { cwd, env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      runtime: "deno",
      args: ["a b"],
      cwd,
    });
  },
);
