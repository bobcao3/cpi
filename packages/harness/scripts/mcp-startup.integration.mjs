import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostCodingAgent, hostAi } from "../bin/host-pi.mjs";
import { create_render_probe } from "./codemode-render-probe.mjs";

const work = await mkdtemp(join(tmpdir(), "cpi-mcp-startup-"));
process.env.CPI_CODING_AGENT_DIR = join(work, "agent");
process.env.PI_OFFLINE = "1";
const host = await hostCodingAgent();
const { getModel } = await hostAi();
host.initTheme("dark", false);
let session;
try {
  const settings = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new host.DefaultResourceLoader({
    cwd: work,
    agentDir: join(work, "agent"),
    settingsManager: settings,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) =>
        pi.registerMcpServer("startup-fixture", {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL("./tool-tree-mcp-fixture.mjs", import.meta.url),
            ),
          ],
        }),
      host.createMcpExtension(),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const manager = host.SessionManager.inMemory(work);
  ({ session } = await host.createAgentSession({
    cwd: work,
    agentDir: join(work, "agent"),
    resourceLoader: loader,
    settingsManager: settings,
    sessionManager: manager,
    model: getModel("anthropic", "claude-sonnet-4-5"),
  }));
  const notifications = [];
  await session.bindExtensions({
    uiContext: {
      ...session.extensionRunner.getUIContext(),
      notify(message, type) {
        notifications.push({ message, type });
      },
    },
  });
  const { run } = create_render_probe({ session, manager, work });
  assert.ok(session.getActiveToolNames().includes("codemode"));
  const verify = async () => {
    assert.deepEqual(notifications, []);
    const code =
      "text((await tools.mcp__startup_fixture__report({})).structuredContent);";
    await session.extensionRunner.emit({
      type: "tool_call",
      toolName: "codemode",
      toolCallId: "mcp-startup",
      input: { code },
    });
    const result = await run("mcp-startup", code);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result.content), /MCP_TYPED_ONLY/);
    assert.deepEqual(notifications, []);
  };
  await verify();
  await session.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  await verify();
  console.log(
    "MCP startup and reload work through cpi codemode without false warnings.",
  );
} finally {
  if (session)
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
  session?.dispose();
  await rm(work, { recursive: true, force: true });
}
process.exit(0);
