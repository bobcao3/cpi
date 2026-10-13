import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { piExecutableOnPath } from "../bin/host-pi.mjs";
import { isolateAgent, packagePath } from "./test-runtime.mjs";
import { terminalCapture } from "./harness/terminal-capture.mjs";

process.env.CPI_TEST_TERMINAL ??= "ghostmux";
const directory = await mkdtemp(join(tmpdir(), "cpi-pi-120-visual-"));
const agentDir = join(directory, "agent");
await mkdir(agentDir);
await writeFile(
  join(agentDir, "subagent-models.md"),
  "Use the local fixture model for integration tests.\n",
);
const restore = isolateAgent(agentDir);
const terminal = terminalCapture(`cpi-migration-${process.pid}`, directory);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const file = join(directory, "中文 sample.ts");
await writeFile(file, "export const version = '1.2.0';\n");
const code = `const file = await tools.read({path:${JSON.stringify(file)}});
const response = await tools.visual_data({});
text(response);
text(JSON.stringify(response));
console.log("VISUAL_CONSOLE");
return {version:"1.2.0", verified:true};`;
const requests = [];
let releaseFinal;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));
  const index = requests.length;
  if (index === 2) await new Promise((resolve) => (releaseFinal = resolve));
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const tool = index === 1 || index === 3;
  const delta = tool
    ? {
        tool_calls: [
          {
            index: 0,
            id: `visual-${index}`,
            type: "function",
            function: { name: "codemode", arguments: JSON.stringify({ code }) },
          },
        ],
      }
    : { content: `MIGRATION_VISUAL_OK_${index}` };
  const emit = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `visual-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
    );
  emit({ role: "assistant" });
  emit(delta);
  emit({}, tool ? "tool_calls" : "stop");
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const until = async (label, check) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    const screen = terminal.capture();
    if (await check(screen)) {
      terminal.save(label, screen);
      return screen;
    }
    await delay(50);
  }
  throw new Error(`${label} timed out:\n${terminal.capture()}`);
};
let started = false;
try {
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 2048,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultProvider: "local",
      defaultModel: "fixture",
      theme: "dark",
      quietStartup: true,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const fixture = join(directory, "visual-fixture.mjs");
  await writeFile(
    fixture,
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { queueMessage } from ${JSON.stringify(packagePath("src/lib/prepend-message.ts"))};
const root = ${JSON.stringify(directory)};
export default function(pi) {
  pi.on("session_start", (_, ctx) => ctx.ui.setStatus("visual-ready", "VISUAL_READY"));
  pi.registerCommand("custom-run", {description:"Run a custom-message fixture", handler() {
    queueMessage({customType:"fixture-before-user", content:"QUEUED_FOR_NEXT_USER"});
    pi.sendMessage({customType:"fixture-trigger", content:"CUSTOM_TURN", display:true}, {triggerTurn:true});
  }});
  pi.registerTool({name:"visual_data", label:"Visual data", description:"Return an MCP result for visual verification", exposure:"codemode",
    parameters:{type:"object",properties:{}}, outputSchema:{type:"object",properties:{content:{type:"array",items:{type:"object"}},structuredContent:{},isError:{type:"boolean"}},required:["content"]},
    async execute() {
      writeFileSync(join(root,"tool-started"), "ready");
      for (let attempt = 0; attempt < 1000 && !existsSync(join(root,"release-tool")); attempt++) await new Promise(resolve => setTimeout(resolve,20));
      return {content:[], details:undefined, structuredContent:{content:[{type:"text",text:"MCP readable output\\n中文 output preserved"}],structuredContent:[1,false,null]}};
    }
  });
}`,
  );
  terminal.start(
    `env CPI_FORK=${quote(process.env.CPI_FORK ?? "")} NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(agentDir)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --no-extensions --no-skills --provider local --model fixture --tools codemode,read,visual_data -e ${quote(packagePath("src/index.ts"))} -e ${quote(fixture)}`,
  );
  started = true;
  await until("startup", (screen) => screen.includes("VISUAL_READY"));
  terminal.send("Verify the migrated codemode and nested output.");
  await until("running", async (screen) => {
    try {
      await readFile(join(directory, "tool-started"));
    } catch {
      return false;
    }
    return /Code mode/.test(screen) && /visual_data/.test(screen);
  });
  await writeFile(join(directory, "release-tool"), "release");
  await until(
    "completed",
    (screen) =>
      !!releaseFinal && /Code mode/.test(screen) && /Output/.test(screen),
  );
  terminal.key("C-o");
  const expanded = await until(
    "expanded",
    (screen) =>
      /MCP readable output/.test(screen) && /VISUAL_CONSOLE/.test(screen),
  );
  assert.match(expanded, /中文 output preserved/);
  assert.match(expanded, /\{"content":\[/);
  terminal.key("PageUp");
  const source = await until("source", (screen) =>
    /JSON\.stringify/.test(screen),
  );
  assert.match(source, /visual_data/);
  terminal.key("PageDown");
  terminal.key("C-o");
  releaseFinal();
  await until("reply", (screen) => screen.includes("MIGRATION_VISUAL_OK_2"));
  terminal.send("/inspect-tools");
  await until("inspector", (screen) => /ESC to dismiss/.test(screen));
  terminal.key("Escape");
  terminal.send("/reload");
  await until("reloaded", (screen) => /Reloaded/i.test(screen));
  terminal.send("Repeat after reload.");
  await until("replay", (screen) => screen.includes("MIGRATION_VISUAL_OK_4"));
  terminal.send("/custom-run");
  await until("custom", (screen) => screen.includes("MIGRATION_VISUAL_OK_5"));
  assert.equal(
    JSON.stringify(requests[4]).includes("QUEUED_FOR_NEXT_USER"),
    false,
  );
  terminal.send("Deliver the next-user message.");
  await until("next-user", (screen) =>
    screen.includes("MIGRATION_VISUAL_OK_6"),
  );
  assert.ok(JSON.stringify(requests[5]).includes("QUEUED_FOR_NEXT_USER"));
  console.log(
    `PASS ghostmux: nested codemode execution, MCP arrays, literal JSON, syntax colors, Unicode, inspector, reload replay, and custom/user startup ordering. Artifacts: ${directory}`,
  );
} finally {
  releaseFinal?.();
  if (started) terminal.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  restore();
}
