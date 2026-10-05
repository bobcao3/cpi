import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { nodeProgram, windows } from "./shell-platform.mjs";
import {
  hostAi,
  hostCodingAgent,
  piExecutableOnPath,
} from "../bin/host-pi.mjs";

process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
const sdk = await hostCodingAgent();
const ai = await hostAi();
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = await mkdtemp(join(tmpdir(), "cpi-vision-integration-"));
const settingsManager = sdk.SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});
const resourceLoader = new sdk.DefaultResourceLoader({
  cwd: work,
  agentDir: join(work, "agent"),
  settingsManager,
  additionalExtensionPaths: [
    join(root, "extensions/lsp.ts"),
    join(root, "extensions/shell.ts"),
  ],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
let session;
const ids = [];
try {
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const vision = ai
    .getModels("openai")
    .find((model) => model.input.includes("image"));
  const text = ai
    .getModels("deepseek")
    .find((model) => !model.input.includes("image"));
  assert.ok(
    vision && text,
    "Installed Pi must provide both image and text models",
  );
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: join(work, "auth.json"),
    modelsPath: join(work, "models.json"),
  });
  await modelRuntime.setRuntimeApiKey(
    vision.provider,
    "unused-no-provider-request",
  );
  await modelRuntime.setRuntimeApiKey(
    text.provider,
    "unused-no-provider-request",
  );
  ({ session } = await sdk.createAgentSession({
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader,
    modelRuntime,
    model: vision,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(work),
    noTools: true,
  }));
  await session.bindExtensions({});
  assert.ok(session.getActiveToolNames().includes("sh_screenshot"));
  const call = async (name, params, signal) => {
    const tool = session.agent.state.tools.find((tool) => tool.name === name);
    assert.ok(tool, `${name} must be active`);
    return tool.execute(`integration-${name}`, params, signal);
  };
  const result = await call("sh", {
    command: await nodeProgram(
      work,
      "terminal",
      `process.stdin.setRawMode(true);
      process.stdout.write('\u001b[?25l\u001b[31mVISION_SCREEN\\r\\n');
      const size = () => process.stdout.write('SIZE:' + process.stdout.getWindowSize().join('x') + '\\r\\n');
      size();
      process.stdout.on('resize', size);
      process.stdin.on('data', () => { process.stdout.write('INPUT_OK\\r\\n'); size(); });
      setTimeout(() => {}, 60000);`,
    ),
    description: "Launch a real colored terminal",
    waitfor: 0.1,
    is_pty: true,
  });
  const id = result.details.id;
  assert.ok(id, JSON.stringify(result));
  ids.push(id);
  const waitOutput = async (pattern) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const output = await readFile(result.details.fullOutputPath, "utf8");
      if (pattern.test(output)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.match(
      await readFile(result.details.fullOutputPath, "utf8"),
      pattern,
    );
  };
  await waitOutput(/VISION_SCREEN/);
  await waitOutput(/SIZE:80x24/);
  const screenshot = await call("sh_screenshot", { id, font_size: 8 });
  const image = screenshot.content.find((part) => part.type === "image");
  assert.ok(image, JSON.stringify(screenshot));
  const { data } = await sharp(Buffer.from(image.data, "base64"))
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let red = false;
  for (let i = 0; i < data.length; i += 3) {
    if (
      data[i] > 50 &&
      data[i] > data[i + 1] * 2 &&
      data[i] > data[i + 2] * 2
    ) {
      red = true;
      break;
    }
  }
  assert.ok(red, "The image must contain the terminal's red foreground");
  const control = async (command) => {
    const response = await call("sh", {
      command: `ghostmux -S '${result.details.socketPath}' ${command} --uid '${result.details.uid}'`,
      description: "Control the live terminal",
      waitfor: 5,
    });
    assert.equal(response.details.exitCode, 0, JSON.stringify(response));
  };
  await control("resize-window --cols 100 --rows 30");
  await control(
    `send-input --text ${windows ? '"geometry`r"' : "'geometry\n'"}`,
  );
  await waitOutput(/INPUT_OK/);
  await waitOutput(/SIZE:100x30/);
  const resized = await call("sh_screenshot", { id, font_size: 8 });
  assert.equal(resized.details.width * 80, screenshot.details.width * 100);
  assert.equal(resized.details.height * 24, screenshot.details.height * 30);
  const pipe = await call("sh", {
    command: await nodeProgram(work, "pipe", "setTimeout(() => {}, 60000);"),
    description: "Launch a pipe session",
    waitfor: 0.1,
  });
  const pipeId = pipe.details.id;
  assert.ok(pipeId);
  ids.push(pipeId);
  await assert.rejects(
    () => call("sh_screenshot", { id: pipeId }),
    /pty|terminal/i,
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => call("sh_screenshot", { id }, abort.signal));
  const stale = session.agent.state.tools.find(
    (tool) => tool.name === "sh_screenshot",
  );
  await session.setModel(text, { persist: false });
  assert.ok(!session.getActiveToolNames().includes("sh_screenshot"));
  await assert.rejects(
    () => stale.execute("non-vision", { id }),
    /image input/i,
  );
  await session.setModel(vision, { persist: false });
  assert.ok(session.getActiveToolNames().includes("sh_screenshot"));
  await call("sh_screenshot", { id, font_size: 20 });
  console.log(
    "Real Pi tools: PTY input, child geometry, resize, screenshot image delivery and dimensions, pipe rejection, cancellation, and model capability switching passed.",
  );
} finally {
  if (session) {
    const signal = session.agent.state.tools.find(
      (tool) => tool.name === "sh_signal",
    );
    for (const id of ids)
      await signal
        ?.execute("cleanup", { id, signal: "SIGKILL" })
        .catch(() => {});
    await session.extensionRunner.emit({ type: "session_shutdown" });
    session.dispose();
  }
  await rm(work, { recursive: true, force: true });
}
