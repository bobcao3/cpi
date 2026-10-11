import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { hostCodingAgent, hostAi } from "../bin/host-pi.mjs";
import { create_render_probe } from "./codemode-render-probe.mjs";
import { packagePath } from "./test-runtime.mjs";

const host = await hostCodingAgent();
const ai = await hostAi();

test(
  "codemode excludes wait_any and explains native promise waiting without disabling direct waits",
  { timeout: 60000 },
  async () => {
    const work = await mkdtemp(join(tmpdir(), "cpi-codemode-wait-"));
    let session;
    try {
      const settings = host.SettingsManager.inMemory({
        codemode: { mode: "only" },
        defaultTools: ["codemode", "wait_any"],
      });
      const loader = new host.DefaultResourceLoader({
        cwd: work,
        agentDir: work,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noThemes: true,
        noContextFiles: true,
        noPromptTemplates: true,
        extensionFactories: [],
        additionalExtensionPaths: [
          packagePath("src/codemode.ts"),
          packagePath("src/wait-any.ts"),
        ],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const manager = host.SessionManager.inMemory(work);
      ({ session } = await host.createAgentSession({
        cwd: work,
        agentDir: work,
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: settings,
        modelRuntime: await host.ModelRuntime.create({
          allowModelNetwork: false,
        }),
        model: ai.getModel("anthropic", "claude-sonnet-4-5"),
      }));
      await session.bindExtensions({});
      const { run } = create_render_probe({ session, manager, work });
      const denied = await run("wait-denied", "await tools.wait_any({});");
      assert.equal(denied.isError, true);
      const message = denied.content.map((part) => part.text ?? "").join("\n");
      assert.match(message, /wait_any.*unavailable.*codemode/);
      assert.match(message, /native JavaScript.*await/);
      assert.match(message, /Promise\.race/);
      assert.notEqual(denied.terminate, true);
      assert.notEqual(denied.awaitingEvent, true);
      assert.equal(
        denied.details.calls.some((call) => call.name === "wait_any"),
        false,
      );
      const caught = await run(
        "wait-caught",
        'try { await tools["wait_any"]({}); } catch (error) { text(error.message); }',
      );
      assert.notEqual(caught.isError, true);
      assert.match(
        caught.content.map((part) => part.text ?? "").join("\n"),
        /native JavaScript.*await.*Promise\.race/,
      );
      const discovered = await run(
        "wait-discovery",
        `
return {
  listed: ALL_TOOLS.some((tool) => tool.name === "wait_any"),
  described: (await describeTool("wait_any")) !== undefined,
  found: (await searchTools("wait_any")).some((tool) => tool.name === "wait_any"),
  selected: await Promise.race([Promise.resolve("ready"), Promise.resolve("later")]),
};`,
      );
      assert.notEqual(discovered.isError, true);
      assert.deepEqual(JSON.parse(discovered.content[1].text), {
        listed: false,
        described: false,
        found: false,
        selected: "ready",
      });
      const direct = session.agent.state.tools.find(
        (tool) => tool.name === "wait_any",
      );
      assert.ok(direct);
      const yielded = await direct.execute(
        "wait-direct",
        {},
        undefined,
        undefined,
      );
      assert.equal(yielded.terminate, true);
      assert.equal(yielded.awaitingEvent, true);
    } finally {
      session?.dispose();
      await rm(work, { recursive: true, force: true });
    }
  },
);
