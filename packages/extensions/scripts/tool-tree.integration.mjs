import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostCodingAgent, hostTui } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const host = await hostCodingAgent();
const tui = await hostTui();
host.initTheme("dark", false);
const values = [
  { marker: "GENERIC_TYPED_ONLY", enabled: false },
  null,
  false,
  [3, 11],
  '{"literal":"JSON string"}',
];
let target = "tree_direct";
let arguments_value = { index: 0 };
const special_call = () => new tui.Text("SPECIALIZED_CALL", 0, 0);
const special_result = () => new tui.Text("SPECIALIZED_RESULT", 0, 0);
function register(pi) {
  pi.registerMcpServer("tree", {
    command: process.execPath,
    args: [
      fileURLToPath(new URL("./tool-tree-mcp-fixture.mjs", import.meta.url)),
    ],
    exposure: "direct",
  });
  pi.registerTool({
    name: "tree_direct",
    label: "tree_direct",
    description: "Renderer fixture",
    defaultActive: true,
    parameters: {
      type: "object",
      properties: { index: { type: "number" } },
      required: ["index"],
    },
    outputSchema: {
      anyOf: [
        { type: "object" },
        { type: "null" },
        { type: "boolean" },
        { type: "array" },
        { type: "string" },
      ],
    },
    async execute(_id, { index }) {
      return {
        content: [{ type: "text", text: "GENERIC_MODEL_TEXT" }],
        structuredContent: values[index],
        details: undefined,
      };
    },
  });
  pi.registerTool({
    name: "mcp__custom__special",
    label: "special",
    description: "Specialized renderer fixture",
    defaultActive: true,
    parameters: { type: "object", properties: {} },
    renderCall: special_call,
    renderResult: special_result,
    async execute() {
      return {
        content: [{ type: "text", text: "SPECIAL_MODEL_TEXT" }],
        details: undefined,
      };
    },
  });
}
const plain = (component, width = 120) =>
  component.render(width).map(tui.stripTerminalSequences).join("\n");
function click(component, pattern) {
  const lines = plain(component).split("\n");
  const y = lines.findIndex((line) => pattern.test(line));
  assert(y >= 0, `${pattern}\n${lines.join("\n")}`);
  const x = lines[y].search(/[▸▾]/);
  assert.equal(
    component.handleMouse({
      type: "click",
      button: "left",
      x,
      y,
      screenX: x,
      screenY: y,
      width: 120,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    })?.handled,
    true,
  );
}
await fixture(
  async ({ runtime, directory, requests }) => {
    const services = await host.createAgentSessionServices({
      cwd: directory,
      agentDir: directory,
      modelRuntime: runtime,
      resourceLoaderOptions: {
        noSkills: true,
        noContextFiles: true,
        extensionFactories: [
          ...host.builtInExtensions.filter(
            (extension) => extension.name !== "codemode",
          ),
          register,
        ],
      },
    });
    assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
    services.settingsManager.setDefaultModelAndProvider("openai", "gpt-5.5");
    const manager = host.SessionManager.create(
      directory,
      join(directory, "sessions"),
    );
    const { session } = await host.createAgentSessionFromServices({
      services,
      sessionManager: manager,
    });
    const ui = new tui.TuiMainScreen(new tui.ProcessTerminal());
    ui.stop();
    const resolve = (name) =>
      session.extensionRunner.resolveToolRenderers(name, () =>
        session.getToolDefinition(name),
      );
    const component_for = (name, args, result, outputPad = 1) => {
      const component = new host.ToolExecutionComponent(
        name,
        result.toolCallId,
        args,
        { showImages: false, outputPad },
        resolve(name),
        ui,
        directory,
      );
      component.updateResult(result);
      return component;
    };
    try {
      await session.bindExtensions({ mode: "print" });
      for (const [index, value] of values.entries()) {
        target = "tree_direct";
        arguments_value = { index };
        await session.prompt("Run the renderer fixture");
        const result = session.messages.findLast(
          (message) => message.role === "toolResult",
        );
        assert.deepEqual(result.structuredContent, value);
        assert.deepEqual(result.content, [
          { type: "text", text: "GENERIC_MODEL_TEXT" },
        ]);
        const component = component_for(target, arguments_value, result);
        if (index === 0) {
          for (const padding of [0, 1, 3]) {
            const padded = component_for(
              target,
              arguments_value,
              result,
              padding,
            );
            assert(
              plain(padded)
                .split("\n")
                .find((line) => line.trim())
                .startsWith(`${" ".repeat(padding)}✓ ▸ tree_direct`),
              JSON.stringify(plain(padded)),
            );
            click(padded, /▸ tree_direct/);
            click(padded, /▸ result/);
            assert.match(plain(padded), /GENERIC_TYPED_ONLY/);
            for (const width of [1, 2, 3, 12, 120])
              assert(
                padded
                  .render(width)
                  .every((line) => tui.visibleWidth(line) <= width),
              );
            padded.setOutputPad(0);
            assert(
              plain(padded)
                .split("\n")
                .find((line) => line.trim())
                .startsWith("✓ ▾ tree_direct"),
            );
          }
        }
        assert.equal(
          plain(component)
            .split("\n")
            .filter((line) => line.trim()).length,
          1,
        );
        click(component, /▸ tree_direct/);
        click(component, /▸ result/);
        const shown = plain(component);
        assert.match(shown, /GENERIC_MODEL_TEXT/);
        if (value === null) assert.match(shown, /result:\s+null/);
        else if (value === false) assert.match(shown, /result:\s+false/);
        else if (typeof value === "string")
          assert(shown.includes("JSON string"));
        for (const width of [1, 20, 80, 120])
          assert(
            component
              .render(width)
              .every((line) => tui.visibleWidth(line) <= width),
          );
        component.setExpanded(true);
        assert.match(plain(component), /GENERIC_MODEL_TEXT/);
        component.invalidate();
        assert.match(plain(component), /GENERIC_MODEL_TEXT/);
        component.setExpanded(false);
        assert.equal(
          plain(component)
            .split("\n")
            .filter((line) => line.trim()).length,
          1,
        );
      }
      target = "mcp__tree__report";
      arguments_value = {};
      await session.prompt("Run the MCP renderer fixture");
      const mcp = session.messages.findLast(
        (message) => message.role === "toolResult",
      );
      const live = component_for(target, {}, mcp);
      assert.match(plain(live), /▸ tree\/report/);
      click(live, /▸ tree\/report/);
      click(live, /▸ result/);
      assert.match(plain(live), /MCP_TYPED_ONLY/);
      const saved = host.SessionManager.open(manager.getSessionFile())
        .getEntries()
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      const restored = saved.findLast(
        (message) => message.role === "toolResult",
      );
      assert.deepEqual(restored.structuredContent, mcp.structuredContent);
      const replay = component_for("mcp__offline__report", {}, restored);
      replay.setExpanded(true);
      assert.match(plain(replay), /MCP_TYPED_ONLY/);
      assert.equal(resolve("mcp__custom__special").renderCall, special_call);
      assert.equal(
        resolve("mcp__custom__special").renderResult,
        special_result,
      );
      const html = await readFile(
        await session.exportToHtml(join(directory, "tree.html")),
        "utf8",
      );
      const encoded =
        /<script id="session-data" type="application\/json">([^<]*)<\/script>/.exec(
          html,
        )[1];
      const exported = JSON.parse(
        Buffer.from(encoded, "base64").toString("utf8"),
      );
      assert(
        exported.renderedTools[mcp.toolCallId].resultHtmlExpanded.includes(
          "MCP_TYPED_ONLY",
        ),
      );
      assert(
        !JSON.stringify(requests.map((request) => request.body)).includes(
          "MCP_TYPED_ONLY",
        ),
      );
      assert(
        !JSON.stringify(requests.map((request) => request.body)).includes(
          "GENERIC_TYPED_ONLY",
        ),
      );
      arguments_value = { large: true, error: true };
      await session.prompt("Run the overflowing MCP error fixture");
      const overflow = session.messages.findLast(
        (message) => message.role === "toolResult",
      );
      assert.equal(overflow.isError, true);
      const overflow_view = component_for(target, arguments_value, overflow);
      assert.match(plain(overflow_view), /✗ ▸ tree\/report/);
      const full_path = overflow.details.fullOutputPath;
      try {
        assert(plain(overflow_view).includes(full_path));
        assert.equal(
          await readFile(full_path, "utf8"),
          "MCP_MODEL_TEXT\n".repeat(3000),
        );
        overflow_view.setExpanded(true);
        assert.match(plain(overflow_view), /MCP_TYPED_ONLY/);
        assert.match(plain(overflow_view), /error:/);
      } finally {
        await rm(full_path, { force: true });
      }
      await session.reload();
      const reloaded = component_for("mcp__offline__report", {}, restored);
      reloaded.setExpanded(true);
      assert.match(plain(reloaded), /MCP_TYPED_ONLY/);
      console.log(
        "Renderer resolvers passed real direct/MCP execution, typed replay, HTML export, custom renderers, mouse expansion, widths, and reload; provider content stayed unchanged.",
      );
    } finally {
      session.dispose();
    }
  },
  100,
  undefined,
  (requests) =>
    requests.length % 2
      ? {
          type: "function_call",
          id: `fc_tree_${requests.length}`,
          call_id: `tree_${requests.length}`,
          name: target,
          arguments: JSON.stringify(arguments_value),
          status: "completed",
        }
      : undefined,
);
process.exit(0);
