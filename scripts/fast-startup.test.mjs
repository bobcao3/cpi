import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./fast-fixture.mjs";
import { activePiRoot, hostCodingAgent } from "../bin/host-pi.mjs";

const {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
} = await hostCodingAgent();
const extension = fileURLToPath(
  new URL("../extensions/fast.ts", import.meta.url),
);

async function runPi(directory, model, requests) {
  const child = spawn(
    process.execPath,
    [
      join(activePiRoot(), "dist/bundle/cli.js"),
      "--no-extensions",
      "--extension",
      extension,
      "--no-skills",
      "--no-context-files",
      "--no-tools",
      "--no-session",
      "--provider",
      "openai",
      "--model",
      model,
      "--api-key",
      "test",
      "--print",
      "Say OK",
    ],
    { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: directory } },
  );
  child.stdin.end();
  let stderr = "";
  let stdout = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (text) => (stderr = (stderr + text).slice(-8192)));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => (stdout = (stdout + text).slice(-8192)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  try {
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(
      code,
      0,
      `${signal}: requests=${requests.length} ${stderr}\n${stdout}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

test("the installed Pi CLI resolves the fast identity before selection", async () => {
  await fixture(async ({ directory, requests }) => {
    await runPi(directory, "gpt-5.5-fast:low", requests);
    assert.equal(requests.at(-1)?.body.model, "gpt-5.5");
    assert.equal(requests.at(-1)?.body.service_tier, "priority");
  });
});

test("saved default and resumed session keep the fast model identity", async () => {
  await fixture(async ({ runtime, directory, requests }) => {
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [extension],
        noSkills: true,
        noContextFiles: true,
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    services.settingsManager.setDefaultModelAndProvider(
      "openai",
      "gpt-5.5-fast",
    );
    await services.settingsManager.flush();
    const savedSettings = SettingsManager.create(directory, directory);
    assert.equal(savedSettings.getDefaultProvider(), "openai");
    assert.equal(savedSettings.getDefaultModel(), "gpt-5.5-fast");
    const initial = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(directory),
      tools: [],
    });
    assert.equal(initial.session.model.id, "gpt-5.5-fast");
    initial.session.dispose();
    const sessionDir = join(directory, "sessions");
    const manager = SessionManager.create(directory, sessionDir);
    manager.appendModelChange("openai", "gpt-5.5-fast");
    manager.appendMessage({
      role: "user",
      content: "Before restore",
      timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    assert.ok(file);
    const restored = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.open(file, sessionDir, directory),
      tools: [],
    });
    try {
      assert.equal(restored.session.model.id, "gpt-5.5-fast");
      await restored.session.bindExtensions({ mode: "print" });
      await restored.session.prompt("Continue");
      assert.equal(requests.at(-1)?.body.model, "gpt-5.5");
      assert.equal(requests.at(-1)?.body.service_tier, "priority");
    } finally {
      restored.session.dispose();
    }
  });
});
