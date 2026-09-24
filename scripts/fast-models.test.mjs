import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { fixture } from "./fast-fixture.mjs";
import { runFastWorker } from "./fast-worker.mjs";
import { join } from "node:path";
import { hostCodingAgent, hostAi } from "../bin/host-pi.mjs";
import { selectForkProbeSubstitute } from "../bin/fork-probe-model.mjs";
import { isGeneratedFastModel, resolveFastModel } from "../bin/fast-models.mjs";

const {
  resolveCliModel,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
} = await hostCodingAgent();
const { calculateCost } = await hostAi();

test("probe substitution rules match only generated variants by canonical ID", async () => {
  await fixture(async ({ runtime }) => {
    const manager = SessionManager.inMemory();
    manager.appendModelChange("openai", "gpt-5.5-fast");
    const selection = selectForkProbeSubstitute(
      { modelSubstitutions: [{ from: "gpt-5.5", to: "gpt-5.4-nano:low" }] },
      { modelRuntime: runtime },
      manager,
    );
    assert.equal(selection.model.id, "gpt-5.4-nano");
    assert.equal(selection.thinkingLevel, "low");
  });
});

test("unavailable persisted fast identity cannot silently execute normal service", async () => {
  await fixture(async ({ runtime, directory, requests }) => {
    const previousSubagent = process.env.PI_SUBAGENT;
    delete process.env.PI_SUBAGENT;
    const manager = SessionManager.inMemory();
    manager.appendModelChange("openai", "gpt-unavailable-fast");
    manager.appendMessage({
      role: "user",
      content: "Previous task",
      timestamp: Date.now(),
    });
    const services = await createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [join(process.cwd(), "extensions/fast.ts")],
        noSkills: true,
      },
    });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      tools: [],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      assert.equal(session.model.id, "gpt-unavailable-fast");
      await session.prompt("Continue");
      assert.equal(requests.length, 0);
      assert.match(
        session.messages.at(-1).errorMessage,
        /Fast model unavailable/,
      );
    } finally {
      session.dispose();
      if (previousSubagent !== undefined)
        process.env.PI_SUBAGENT = previousSubagent;
    }
  });
});

test("CLI and fork runners initialize variants before resolution", async () => {
  await fixture(async ({ directory, requests }) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      for (const model of ["openai/gpt-5.5-fast:low", "openai/gpt-5.5:low"]) {
        const result = await runFastWorker({
          argv: ["-m", model],
          cwd: directory,
          env: {},
          task: "Reply OK",
          runId: model.includes("-fast") ? "fast-test" : "base-test",
        });
        assert.equal(result, 0);
        assert.equal(requests.at(-1).body.model, "gpt-5.5");
        assert.equal(
          requests.at(-1).body.service_tier,
          model.includes("-fast") ? "priority" : undefined,
        );
      }
      const parent = SessionManager.create(
        directory,
        join(directory, "parent"),
      );
      parent.appendModelChange("openai", "gpt-5.5-fast");
      parent.appendMessage({
        role: "user",
        content: "Initial task",
        timestamp: Date.now(),
      });
      parent.appendMessage({
        role: "assistant",
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.5-fast",
        content: [{ type: "text", text: "OK" }],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      });
      const result = await runFastWorker({
        kind: "fork-probe",
        parentSessionFile: parent.getSessionFile(),
        parentSessionId: parent.getSessionId(),
        sessionDir: join(directory, "fork"),
        cwd: directory,
        prompt: "Reply OK",
        model: "openai/gpt-5.5-fast:low",
        tools: "",
      });
      assert.equal(result, 0);
      assert.equal(requests.at(-1).body.model, "gpt-5.5");
      assert.equal(requests.at(-1).body.service_tier, "priority");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

test("session workers resolve and execute explicit base and fast models independently", async () => {
  await fixture(async ({ directory, requests }) => {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    try {
      for (const modelId of ["gpt-5.5-fast", "gpt-5.5"]) {
        const result = await runFastWorker({
          version: 1,
          kind: "session",
          provider: "openai",
          modelId,
          thinkingLevel: "low",
          cwd: directory,
          systemPrompt: "",
          extensionPaths: [],
          tools: [],
          task: "Say OK",
          maxTurns: 1,
          maxOutputBytes: 1024,
        });
        assert.equal(result, 0);
        assert.equal(requests.at(-1).body.model, "gpt-5.5");
        assert.equal(
          requests.at(-1).body.service_tier,
          modelId.endsWith("-fast") ? "priority" : undefined,
        );
      }
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  });
});

test("real Responses and Codex adapters send canonical priority requests and preserve alias costs/identity", async () => {
  await fixture(async ({ runtime, requests }) => {
    for (const provider of ["openai", "openai-codex"]) {
      const model = runtime.getModel(provider, "gpt-5.5-fast");
      assert.ok(isGeneratedFastModel(model));
      const result = await runtime.completeSimple(
        model,
        {
          messages: [
            { role: "user", content: "Say OK", timestamp: Date.now() },
          ],
        },
        { reasoning: "low", transport: "sse", maxTokens: 32 },
      );
      assert.notEqual(result.stopReason, "error", result.errorMessage);
      assert.equal(result.model, model.id);
      const request = requests.at(-1).body;
      assert.equal(request.model, "gpt-5.5");
      assert.equal(request.service_tier, "priority");
      assert.equal(request.reasoning.effort, "low");
      const expected = structuredClone(result.usage);
      calculateCost(model, expected);
      for (const field of Object.keys(expected.cost))
        assert.ok(
          Math.abs(result.usage.cost[field] - expected.cost[field]) < 1e-12,
          field,
        );
    }
  });
});

test("refresh observes models.json; explicit registration takes ownership without changing auth or models", async () => {
  await fixture(
    async ({ runtime, config, modelsPath, baseUrl, apiKey, requests }) => {
      const stale = runtime.getModel("openai", "gpt-5.5-fast");
      config.providers.openai.modelOverrides = {
        "gpt-5.5": {
          cost: { input: 19, output: 23, cacheRead: 7, cacheWrite: 0 },
        },
      };
      await writeFile(modelsPath, JSON.stringify(config));
      await runtime.refresh({ allowNetwork: false });
      assert.equal(runtime.getModel("openai", "gpt-5.5-fast").cost.input, 47.5);
      const base = runtime.getModel("openai", "gpt-5.5");
      const custom = {
        ...base,
        id: "gpt-5.5-fast",
        name: "Owner's model",
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      };
      runtime.registerProvider("openai", {
        baseUrl,
        apiKey,
        api: "openai-responses",
        models: [base, custom],
      });
      await runtime.refresh({ allowNetwork: false });
      const owned = runtime.getModel("openai", custom.id);
      assert.equal(isGeneratedFastModel(owned), false);
      assert.equal(owned.name, custom.name);
      assert.equal(owned.cost.input, 1);
      const selection = resolveFastModel(resolveCliModel, {
        cliProvider: "openai",
        cliModel: custom.id,
        modelRuntime: runtime,
      });
      assert.equal(selection.model.id, custom.id);
      assert.equal(selection.model.cost.input, 1);
      assert.equal(isGeneratedFastModel(selection.model), false);
      const result = await runtime.completeSimple(
        stale,
        { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] },
        { transport: "sse", maxTokens: 32 },
      );
      assert.notEqual(result.stopReason, "error", result.errorMessage);
      assert.equal(requests.at(-1).body.model, custom.id);
      assert.equal(requests.at(-1).body.service_tier, undefined);
      assert.equal(
        runtime.getRegisteredProviderConfig("openai").apiKey,
        apiKey,
      );
    },
  );
});

test("explicit selectors resolve aliases; fuzzy selectors never select generated priority variants", async () => {
  await fixture(async ({ runtime }) => {
    for (const id of ["gpt-5.5", "gpt-5.5-fast"]) {
      const result = resolveFastModel(resolveCliModel, {
        cliModel: `openai/${id}:high`,
        modelRuntime: runtime,
      });
      assert.equal(result.model.id, id);
      assert.equal(result.thinkingLevel, "high");
    }
    const fuzzy = resolveFastModel(resolveCliModel, {
      cliProvider: "openai",
      cliModel: "gpt-5",
      modelRuntime: runtime,
    });
    assert.equal(isGeneratedFastModel(fuzzy.model), false);
    assert.throws(
      () =>
        resolveFastModel(resolveCliModel, {
          cliProvider: "openai",
          cliModel: "gpt-nonexistent-fast",
          modelRuntime: runtime,
        }),
      /unavailable/,
    );
  });
});

test("real extension commands persist model identity and thinking effort, with branch-local legacy migration", async () => {
  await fixture(async ({ runtime, directory }) => {
    const services = await createAgentSessionServices({
      cwd: process.cwd(),
      agentDir: directory,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        noExtensions: true,
        additionalExtensionPaths: [join(process.cwd(), "extensions/fast.ts")],
        noSkills: true,
        noContextFiles: true,
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    const manager = SessionManager.inMemory();
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: manager,
      model: runtime.getModel("openai", "gpt-5.5"),
      thinkingLevel: "high",
      tools: [],
    });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.prompt("/fast on");
      assert.equal(session.model.id, "gpt-5.5-fast");
      assert.equal(session.thinkingLevel, "high");
      assert.equal(manager.buildSessionContext().model.modelId, "gpt-5.5-fast");
      await session.prompt("/fast off");
      assert.equal(session.model.id, "gpt-5.5");
      await session.prompt("/fast");
      assert.equal(session.model.id, "gpt-5.5-fast");
      await session.prompt("/fast toggle");
      assert.equal(session.model.id, "gpt-5.5-fast");
      assert.ok(
        !manager
          .getBranch()
          .some(
            (entry) =>
              entry.type === "custom" && entry.customType === "fast-state",
          ),
      );
      await session.prompt("/fast off");
      manager.appendCustomEntry("fast-state", { enabled: true });
      await session.extensionRunner.emit({ type: "session_tree" });
      assert.equal(session.model.id, "gpt-5.5-fast");
      await session.prompt("/fast off");
      await session.extensionRunner.emit({ type: "session_tree" });
      assert.equal(session.model.id, "gpt-5.5");
    } finally {
      session.dispose();
    }
  });
});
