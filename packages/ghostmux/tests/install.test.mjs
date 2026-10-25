import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packageRoot, platformKey } from "../bin/ghostmux-source.mjs";
import { stage_wrapper } from "../scripts/ghostmux-package.mjs";
import { registry_manifest } from "../../cli/scripts/registry-manifest.mjs";
import {
  execute,
  install,
  pack,
  registry,
} from "../../../scripts/package-test.mjs";

const directory = await mkdtemp(join(tmpdir(), "gmi-"));
let server;
try {
  const platform = platformKey();
  const signed = process.env.GHOSTMUX_TEST_ARTIFACT;
  const release = join(directory, "release");
  const wrapper = signed
    ? join(release, "ghostmux")
    : join(directory, "wrapper");
  let artifacts = [];
  if (signed) {
    execute(process.execPath, [
      join(packageRoot, "scripts/package.mjs"),
      signed,
      release,
      platform,
    ]);
    const packages = JSON.parse(
      await readFile(join(release, "packages.json"), "utf8"),
    );
    artifacts = packages.map((pkg) => ({
      directory: join(
        release,
        pkg.name.endsWith(`ghostmux-${platform}`)
          ? `ghostmux-${platform}`
          : "ghostmux",
      ),
      archive: join(release, pkg.filename),
    }));
  } else {
    const source = await stage_wrapper(wrapper);
    const versions = new Map([
      [source.name, source.version],
      ...Object.keys(source.optionalDependencies).map((name) => [
        name,
        source.version,
      ]),
    ]);
    await writeFile(
      join(wrapper, "package.json"),
      `${JSON.stringify(registry_manifest(source, versions), null, 2)}\n`,
    );
  }
  const wrapper_manifest_path = join(wrapper, "package.json");
  const wrapper_manifest = JSON.parse(
    await readFile(wrapper_manifest_path, "utf8"),
  );
  wrapper_manifest.version += "-wrapper";
  await writeFile(
    wrapper_manifest_path,
    `${JSON.stringify(wrapper_manifest, null, 2)}\n`,
  );
  artifacts = artifacts.filter((entry) => entry.directory !== wrapper);
  artifacts.push({ directory: wrapper, archive: pack(wrapper, directory) });
  server = await registry(artifacts);
  for (const manager of ["npm", "bun"]) {
    const consumer = join(directory, manager);
    await install(manager, consumer, "@bobcao3/cpi-ghostmux", server.url);
    await chmod(consumer, 0o700);
    const installed = join(consumer, "node_modules/@bobcao3/cpi-ghostmux");
    await assert.rejects(access(join(installed, "zig-out")), {
      code: "ENOENT",
    });
    await assert.rejects(access(join(installed, "src")), { code: "ENOENT" });
    const realBinary = signed
      ? join(
          consumer,
          "node_modules",
          `@cpi/ghostmux-${platform}`,
          "bin",
          process.platform === "win32" ? "ghostmux.exe" : "ghostmux",
        )
      : resolve(
          process.env.GHOSTMUX_BIN ||
            join(
              packageRoot,
              "zig-out/bin",
              process.platform === "win32" ? "ghostmux.exe" : "ghostmux",
            ),
        );
    const launcher = join(installed, "bin/ghostmux.mjs");
    await mkdir(join(consumer, "local"));
    const environment = {
      ...process.env,
      GHOSTMUX_BIN: signed ? "" : realBinary,
      GHOSTMUX_BUILD: "",
      PATH: "",
      XDG_CACHE_HOME: join(consumer, "empty-cache"),
      LOCALAPPDATA: join(consumer, "local"),
      HTTP_PROXY: "http://127.0.0.1:1",
      HTTPS_PROXY: "http://127.0.0.1:1",
    };
    const run = (args, options = {}) =>
      execute(process.execPath, [launcher, ...args], {
        env: environment,
        ...options,
      });
    assert.equal(run(["--resolve"]).trim(), realBinary);
    assert.equal(
      run(["--history", "--join"], { input: "installed\r\n中文 😀\r\n" }),
      "installed\n中文 😀\n",
    );
    const socket =
      process.platform === "win32"
        ? []
        : ["-S", join(consumer, "command.sock")];
    for (const isPty of [false, true]) {
      const events = run([
        ...socket,
        "new-session",
        "--uid",
        `installed-package-${isPty}`,
        "--is-pty",
        String(isPty),
        "--subscribe",
        "--json",
        "--",
        process.execPath,
        "-e",
        `if (Boolean(process.stdin.isTTY) !== ${isPty} || Boolean(process.stdout.isTTY) !== ${isPty}) { process.stdout.write(JSON.stringify({expectedPty:${isPty},stdinTTY:Boolean(process.stdin.isTTY),stdoutTTY:Boolean(process.stdout.isTTY)})+'\\n',()=>process.exit(99)); } else { process.stdout.write('installed daemon'); process.exitCode=7; }`,
      ])
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.equal(events[0].event, "subscribed");
      assert.equal(events.at(-1).event, "exit");
      const output = Buffer.concat(
        events
          .filter((event) => event.event === "data")
          .map((event) => Buffer.from(event.base64, "base64")),
      );
      assert.equal(events.at(-1).session.exit_code, 7, output.toString());
      assert.equal(
        isPty
          ? run(["--history", "--join"], { input: output }).trimEnd()
          : output.toString(),
        "installed daemon",
      );
    }

    const failed = (env = environment) => {
      const result = spawnSync(process.execPath, [launcher, "--resolve"], {
        env,
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(result.status, 1, result.stdout);
      return result.stderr;
    };
    assert.match(
      failed({ ...environment, GHOSTMUX_BIN: "relative" }),
      /absolute executable path/,
    );
    if (signed) {
      const manifestPath = join(realBinary, "../../package.json");
      const manifest = await readFile(manifestPath, "utf8");
      await writeFile(
        manifestPath,
        JSON.stringify({ ...JSON.parse(manifest), version: "999.0.0" }),
      );
      assert.match(failed(), /version mismatch/);
      await writeFile(manifestPath, manifest);
      const signature = await readFile(`${realBinary}.minisig`);
      const altered = Buffer.from(signature);
      altered[altered.length - 5] =
        altered[altered.length - 5] === 65 ? 66 : 65;
      await writeFile(`${realBinary}.minisig`, altered);
      assert.match(failed(), /signature verification failed/);
      await writeFile(`${realBinary}.minisig`, signature);
      const native = join(
        consumer,
        "node_modules",
        `@cpi/ghostmux-${platform}`,
      );
      await rename(native, `${native}.removed`);
      assert.match(failed(), /optional dependencies enabled/);
    }
    console.log(
      `${manager}: installed Ghostmux captures and managed commands passed`,
    );
  }
  if (signed)
    assert(
      server.requests.includes(
        `@bobcao3/cpi-ghostmux-${platform}/-/package.tgz`,
      ),
    );
} finally {
  if (server) await server.close();
  await rm(directory, { recursive: true, force: true });
}
