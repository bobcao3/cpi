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
import { resolveGhostmux } from "@cpi/ghostmux/resolve";
import { shellCommand, windows, nodeProgram } from "./shell-platform.mjs";

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
  await mkdir(join(installed, "node_modules", "@cpi"), { recursive: true });
  for (const dependency of [
    "jiti",
    "mustache",
    "sharp",
    "smol-toml",
    "@cpi/ghostmux",
    "@cpi/tree-sitter-wasm",
  ]) {
    let source = dirname(fileURLToPath(import.meta.resolve(dependency)));
    let found = false;
    for (let depth = 0; depth < 10; depth++) {
      try {
        const manifest = JSON.parse(
          await readFile(join(source, "package.json"), "utf8"),
        );
        if (manifest.name === dependency) {
          found = true;
          break;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      source = dirname(source);
    }
    assert(found, `Cannot locate installed dependency ${dependency}`);
    await symlink(
      source,
      join(installed, "node_modules", dependency),
      windows ? "junction" : "dir",
    );
  }
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
    extensionFactories: [host.createCodemodeExtension()],
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
  session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
  const call_codemode = async (id, code) => {
    session.agent.state.messages.push({
      role: "assistant",
      content: [
        { type: "toolCall", id, name: "codemode", arguments: { code } },
      ],
      api: session.model.api,
      provider: session.model.provider,
      model: session.model.id,
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return session.agent.state.tools
      .find((tool) => tool.name === "codemode")
      .execute(id, { code });
  };
  const structured = await call_codemode(
    "installed-structured",
    `
    const results = await Promise.all([
      tools.sh({ description: "Structured success", command: ${JSON.stringify(shellCommand("printf structured-ok", "[Console]::Write('structured-ok')"))}, waitfor: 2 }),
      tools.sh({ description: "Structured failure", command: ${JSON.stringify(shellCommand("printf structured-error; exit 7", "[Console]::Write('structured-error'); exit 7"))}, waitfor: 2 }),
      tools.sh({ description: "Structured blocked", command: "printf must-not-run", waitfor: 31 }),
    ]);
    return results;
  `,
  );
  assert.notEqual(structured.isError, true, JSON.stringify(structured));
  const values = JSON.parse(
    structured.content
      .slice(1)
      .map((block) => block.text)
      .join(""),
  );
  assert.equal(values[0].output, "structured-ok");
  assert.equal(values[0].exit_code, 0);
  assert.equal(values[0].is_error, false);
  assert.equal(values[1].output, "structured-error");
  assert.equal(values[1].exit_code, 7);
  assert.equal(values[1].is_error, true);
  assert.equal(values[2].status, "blocked");
  assert.equal(values[2].id, null);
  assert.equal(values[2].is_error, true);
  assert.equal(
    structured.details.calls.filter((call) => call.status === "error").length,
    2,
  );
  const large_output = "START" + "x".repeat(100000) + "END";
  const large_command = await nodeProgram(
    directory,
    "structured-large",
    `process.stdout.write(${JSON.stringify(large_output)});`,
  );
  const large = await call_codemode(
    "installed-large",
    `
    return await tools.sh({ description: "Structured bounded output", command: ${JSON.stringify(large_command)}, waitfor: 2 });
  `,
  );
  assert.notEqual(large.isError, true, JSON.stringify(large));
  const bounded = JSON.parse(
    large.content
      .slice(1)
      .map((block) => block.text)
      .join(""),
  );
  assert.equal(bounded.exit_code, 0);
  assert(bounded.output.length < large_output.length);
  assert.equal(await readFile(bounded.full_output_path, "utf8"), large_output);
  const sh = session._toolRegistry.get("sh");
  const result = await sh.execute(
    "installed-shell",
    {
      description: "Installed shell",
      command: shellCommand(
        "printf installed-shell; command -v ghostmux",
        "Write-Output installed-shell; (Get-Command ghostmux).Source",
      ),
      waitfor: 2,
    },
    undefined,
    undefined,
  );
  assert.equal(result.isError, false, JSON.stringify(result));
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
      command: await nodeProgram(
        directory,
        "interactive",
        "process.stdout.write('ready'); process.stdin.once('data', data => { process.stdout.write(data); process.exit(0); });",
      ),
      waitfor: 0.05,
      is_pty: true,
    },
    undefined,
    undefined,
  );
  assert.equal(interactive.details.status, "running");
  assert.equal(interactive.structuredContent.status, "running");
  assert.equal(interactive.structuredContent.id, interactive.details.id);
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
    const forwarded = await call_codemode(
      "installed-screen",
      `
      const screen = await tools.sh_screenshot({ id: ${JSON.stringify(interactive.details.id)}, font_size: 12 });
      image(screen.image);
      return { width: screen.width, height: screen.height };
    `,
    );
    assert.notEqual(forwarded.isError, true);
    const image = forwarded.content.find((block) => block.type === "image");
    assert.ok(image);
    assert.equal(
      Buffer.from(image.data, "base64").subarray(1, 4).toString(),
      "PNG",
    );
    const dimensions = JSON.parse(
      forwarded.content
        .filter((block) => block.type === "text")
        .slice(1)
        .map((block) => block.text)
        .join(""),
    );
    assert.equal(dimensions.width, screenshot.details.width);
    assert.equal(dimensions.height, screenshot.details.height);
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
