import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  artifactName,
  packageRoot,
  platformKey,
} from "../bin/ghostmux-source.mjs";

const directory = await mkdtemp(join(tmpdir(), "gmi-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
try {
  const pack = JSON.parse(
    execute(
      npm,
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      {
        cwd: packageRoot,
        shell: process.platform === "win32",
      },
    ),
  );
  const packed = Array.isArray(pack) ? pack[0] : Object.values(pack)[0];
  execute("tar", ["-xzf", join(directory, packed.filename), "-C", directory]);
  const installed = join(directory, "package");
  await assert.rejects(access(join(installed, "node_modules")), {
    code: "ENOENT",
  });
  await assert.rejects(
    access(join(installed, "tools", "ghostmux", "zig-out")),
    { code: "ENOENT" },
  );
  const { sourceDigest } = await import(
    pathToFileURL(join(installed, "bin", "ghostmux-source.mjs"))
  );
  const source = await import("../bin/ghostmux-source.mjs");
  assert.equal(await sourceDigest(), await source.sourceDigest());
  const filename = artifactName(platformKey());
  const realBinary = resolve(
    process.env.GHOSTMUX_BIN ||
      join(
        packageRoot,
        "tools",
        "ghostmux",
        "zig-out",
        "bin",
        process.platform === "win32" ? "ghostmux.exe" : "ghostmux",
      ),
  );
  const launcher = join(installed, "bin", "ghostmux.mjs");
  const environment = {
    ...process.env,
    GHOSTMUX_BIN: realBinary,
    GHOSTMUX_BUILD: "",
    PATH: "",
    XDG_CACHE_HOME: join(directory, "cache"),
    LOCALAPPDATA: join(directory, "local"),
  };
  await mkdir(environment.LOCALAPPDATA, { recursive: true });
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
    process.platform === "win32" ? [] : ["-S", join(directory, "command.sock")];
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
  const invalid = spawnSync(process.execPath, [launcher, "--resolve"], {
    env: { ...environment, GHOSTMUX_BIN: "relative-binary" },
    encoding: "utf8",
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /absolute executable path/);
  if (process.env.GHOSTMUX_TEST_ARTIFACT) {
    const cacheBase =
      process.platform === "win32"
        ? environment.LOCALAPPDATA
        : environment.XDG_CACHE_HOME;
    const cache = join(
      cacheBase,
      "cpi",
      "ghostmux",
      await sourceDigest(),
      platformKey(),
    );
    await mkdir(cache, { recursive: true });
    const binary = join(cache, filename);
    await copyFile(join(process.env.GHOSTMUX_TEST_ARTIFACT, filename), binary);
    await copyFile(
      join(process.env.GHOSTMUX_TEST_ARTIFACT, `${filename}.minisig`),
      `${binary}.minisig`,
    );
    await chmod(binary, 0o700);
    delete environment.GHOSTMUX_BIN;
    assert.equal(run(["--resolve"]).trim(), binary);
    assert.equal(run([], { input: "verified\r\n" }), "verified\n");
    const signature = await readFile(`${binary}.minisig`);
    signature[signature.length - 5] =
      signature[signature.length - 5] === 65 ? 66 : 65;
    await writeFile(`${binary}.minisig`, signature);
    const rejected = spawnSync(process.execPath, [launcher, "--resolve"], {
      env: environment,
      encoding: "utf8",
    });
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /signature verification failed/);
    const bundledDirectory = join(installed, "bin", "ghostmux-platform");
    await mkdir(bundledDirectory, { recursive: true });
    const bundledBinary = join(bundledDirectory, filename);
    await copyFile(
      join(process.env.GHOSTMUX_TEST_ARTIFACT, filename),
      bundledBinary,
    );
    await copyFile(
      join(process.env.GHOSTMUX_TEST_ARTIFACT, `${filename}.minisig`),
      `${bundledBinary}.minisig`,
    );
    await chmod(bundledBinary, 0o700);
    assert.equal(run(["--resolve"]).trim(), bundledBinary);
    const installedSource = join(
      installed,
      "tools",
      "ghostmux",
      "src",
      "main.zig",
    );
    await writeFile(
      installedSource,
      Buffer.concat([await readFile(installedSource), Buffer.from("\n")]),
    );
    const sourceMismatch = spawnSync(
      process.execPath,
      [launcher, "--resolve"],
      {
        env: environment,
        encoding: "utf8",
      },
    );
    assert.equal(sourceMismatch.status, 1);
    assert.match(
      sourceMismatch.stderr,
      /does not match the installed sources or platform/,
    );
  }
  console.log(
    "Installed ghostmux package executes native captures and managed commands without Pi peers, Zig, or PATH dependencies.",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
