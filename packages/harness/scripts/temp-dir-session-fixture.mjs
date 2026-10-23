import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { captureSessionOwner } from "../src/lib/storage/owner.ts";
import { stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { localFixture } from "./local-fixture.mjs";
import { release_all } from "./temp-dir-fixture.mjs";
import { guardLocalSession, packagePath } from "./test-runtime.mjs";

export async function temp_session(reply, { native = false } = {}) {
  const host = await hostCodingAgent();
  const previous = new Map(
    ["CPI_STORAGE_ROOT", "PI_SUBAGENT"].map((key) => [key, process.env[key]]),
  );
  const local = await localFixture(reply);
  process.env.CPI_STORAGE_ROOT = join(local.directory, "storage");
  delete process.env.PI_SUBAGENT;
  const owners = new Map();
  const runtimes = [];
  const tools = native
    ? [
        "temp_dir",
        "sh",
        "sh_repeat_until",
        "sh_detach",
        "sh_signal",
        "sh_background_ps",
      ]
    : ["temp_dir"];
  const runtime_for = async (manager) => {
    const create = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await host.createAgentSessionServices({
        cwd,
        agentDir,
        modelRuntime: local.runtime,
        settingsManager: host.SettingsManager.inMemory({
          defaultTools: tools,
          compaction: { enabled: false },
          retry: { enabled: false },
        }),
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noThemes: true,
          noContextFiles: true,
          noPromptTemplates: true,
          additionalExtensionPaths: [
            packagePath("src/core.ts"),
            ...(native
              ? [packagePath("src/shell.ts"), packagePath("src/lsp.ts")]
              : []),
            packagePath("src/temp-dir.ts"),
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const result = await host.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: local.model,
        thinkingLevel: "off",
        tools,
      });
      guardLocalSession(result.session);
      const owner = captureSessionOwner(sessionManager);
      owners.set(JSON.stringify(owner), owner);
      return { ...result, services, diagnostics: services.diagnostics };
    };
    const runtime = await host.createAgentSessionRuntime(create, {
      cwd: local.directory,
      agentDir: local.agentDir,
      sessionManager: manager,
    });
    runtimes.push(runtime);
    const bind = (session) =>
      session.bindExtensions({
        mode: "rpc",
        uiContext: { ...session.extensionRunner.getUIContext() },
        onError: (error) => {
          throw error;
        },
      });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    return runtime;
  };
  const sessions = join(local.directory, "sessions");
  await mkdir(sessions, { mode: 0o700 });
  const manager = host.SessionManager.create(local.directory, sessions);
  try {
    const runtime = await runtime_for(manager);
    return {
      host,
      local,
      manager,
      runtime,
      runtime_for,
      sessions,
      invoke(session, name, parameters) {
        const tool = session._toolRegistry.get(name);
        assert.ok(tool, `Missing ${name}`);
        return tool.execute(randomUUID(), parameters, undefined, undefined);
      },
      async close() {
        try {
          for (const current of runtimes) await current.dispose();
          for (const owner of owners.values()) await release_all(owner);
        } finally {
          for (const current of runtimes) current.session.dispose();
          await stopSubagentRpc();
          for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          await local.close();
        }
      },
    };
  } catch (error) {
    for (const runtime of runtimes) runtime.session.dispose();
    await stopSubagentRpc();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await local.close();
    throw error;
  }
}
