import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import { resolveGhostmux } from "../bin/ghostmux-resolve.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const directory = await mkdtemp(join(tmpdir(), "cpi-shell-installed-"));
const installed = join(directory, "package");
const previousHost = process.env.CPI_PI_HOST_ENTRY;
const previousBinary = process.env.GHOSTMUX_BIN;
process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
process.env.GHOSTMUX_BIN = await resolveGhostmux();
let session;
try {
  await mkdir(installed);
  for (const path of [
    "extensions",
    "bin",
    "cpi-config.default.json",
    "fallback-providers.example.json",
  ]) {
    await cp(join(root, path), join(installed, path), { recursive: true });
  }
  await mkdir(join(installed, "node_modules"));
  for (const dependency of ["mustache", "sharp", "smol-toml"])
    await symlink(
      join(root, "node_modules", dependency),
      join(installed, "node_modules", dependency),
    );
  await assert.rejects(
    stat(join(installed, "node_modules/@earendil-works/pi-coding-agent")),
    { code: "ENOENT" },
  );
  const host = await hostCodingAgent();
  const settings = host.SettingsManager.inMemory();
  const resourceLoader = new host.DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    additionalExtensionPaths: [join(installed, "extensions/shell.ts")],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    settingsManager: settings,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await host.createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader,
    settingsManager: settings,
    sessionManager: host.SessionManager.inMemory(directory),
    noTools: true,
  }));
  await session.bindExtensions({});
  const sh = session._toolRegistry.get("sh");
  const result = await sh.execute(
    "installed-shell",
    {
      description: "Installed shell",
      command: "printf installed-shell; command -v ghostmux",
      waitfor: 2,
    },
    undefined,
    undefined,
  );
  assert.equal(result.isError, false);
  assert(result.content[0].text.includes("installed-shell"));
  assert.equal(result.details.isPty, false);
  assert(result.details.uid);
  assert.equal(
    (await readFile(result.details.fullOutputPath, "utf8")).includes(
      "installed-shell",
    ),
    true,
  );
  const interactive = await sh.execute(
    "installed-terminal",
    {
      description: "Installed terminal",
      command: "printf ready; read answer; printf '%s' \"$answer\"",
      waitfor: 0.05,
      is_pty: true,
    },
    undefined,
    undefined,
  );
  assert.equal(interactive.details.status, "running");
  const registered = resourceLoader
    .getExtensions()
    .extensions.flatMap((extension) => [...extension.tools.keys()]);
  assert(registered.includes("sh_screenshot"));
  if (session.model?.input.includes("image")) {
    const screenshot = await session._toolRegistry
      .get("sh_screenshot")
      .execute(
        "installed-screenshot",
        { id: interactive.details.id, font_size: 12 },
        undefined,
        undefined,
      );
    assert.equal(screenshot.content[1].type, "image");
    assert.equal(
      Buffer.from(screenshot.content[1].data, "base64")
        .subarray(1, 4)
        .toString(),
      "PNG",
    );
  }
  const control = session._toolRegistry.get("sh_signal");
  const killed = await control.execute(
    "installed-stop",
    { id: interactive.details.id, signal: "SIGKILL" },
    undefined,
    undefined,
  );
  assert.notEqual(killed.isError, true);
  const list = session._toolRegistry.get("sh_background_ps");
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      !(await list.execute("installed-list", {}, undefined, undefined)).details
        ?.backgrounds?.length
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    (await list.execute("installed-list-final", {}, undefined, undefined))
      .details,
    undefined,
  );
  const repeated = await session._toolRegistry
    .get("sh_repeat_until")
    .execute(
      "installed-repeat",
      { description: "Installed repeat", command: "exit 3", interval: 5 },
      undefined,
      undefined,
    );
  assert.equal(repeated.details.status, "repeating");
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await list.execute(
      "installed-repeat-list",
      {},
      undefined,
      undefined,
    );
    if (!result.details?.repeats?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(
    (await list.execute("installed-repeat-final", {}, undefined, undefined))
      .details,
    undefined,
  );
  await promisify(execFile)(
    process.execPath,
    [join(root, "scripts/shell-shutdown.integration.mjs"), installed],
    { timeout: 60000 },
  );
  console.log(
    "Installed shell loaded through host Pi and executed without local Pi peers",
  );
} finally {
  if (session)
    await session._extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  session?.dispose();
  if (previousHost === undefined) delete process.env.CPI_PI_HOST_ENTRY;
  else process.env.CPI_PI_HOST_ENTRY = previousHost;
  if (previousBinary === undefined) delete process.env.GHOSTMUX_BIN;
  else process.env.GHOSTMUX_BIN = previousBinary;
  await rm(directory, { recursive: true, force: true });
}

process.exit(0);
