import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import { isolateAgent, packagePath } from "./test-runtime.mjs";
import { terminalCapture } from "./harness/terminal-capture.mjs";

const name = `cpi-runtime-status-${process.pid}`;
const directory = await mkdtemp(join(tmpdir(), `${name}-`));
const agentDir = join(directory, "agent");
await mkdir(agentDir);
const restore = isolateAgent(agentDir);
const quote = (text) => `'${text.replaceAll("'", "'\\''")}'`;
const terminal = terminalCapture(name, directory);
const capture = () => terminal.capture();
const send = (text) => terminal.send(text);
const gates = new Map();
const release = (key) => {
  gates.get(key)?.();
  gates.delete(key);
};
const gate = (key) => new Promise((resolve) => gates.set(key, resolve));
const requests = [];
const captures = {};
async function until(key, check, limit = 200) {
  for (let index = 0; index < limit; index++) {
    const screen = capture();
    if (await check(screen)) {
      captures[key] = screen;
      terminal.save(key, screen);
      return screen;
    }
    await delay(50);
  }
  throw new Error(`${key} timed out:\n${capture()}`);
}
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  requests.push(JSON.parse(raw));
  const index = requests.length;
  if (index === 1 || index === 4) await gate(`api-${index}`);
  if (response.destroyed) return;
  response.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (delta, finish_reason = null) =>
    response.write(
      `data: ${JSON.stringify({ id: `fixture-${index}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } } : {}) })}\n\n`,
    );
  emit({ role: "assistant" });
  if (index === 1) {
    for (let part = 0; part < 6; part++) {
      emit({ reasoning_content: "Thinking about the integration fixture. " });
      await delay(120);
    }
    await gate("stream");
  }
  if (index === 1 || index === 3) {
    emit({
      tool_calls: [
        {
          index: 0,
          id: `call-${index}`,
          type: "function",
          function: {
            name: index === 1 ? "fixture_work" : "wait_any",
            arguments: index === 1 ? "{" : "{}",
          },
        },
      ],
    });
    if (index === 1) {
      await gate("tool-writing");
      emit({ tool_calls: [{ index: 0, function: { arguments: "}" } }] });
    }
    emit({}, "tool_calls");
  } else {
    for (const content of ["RUNTIME_", "STATUS_", "VERIFIED", "."]) {
      emit({ content });
      await delay(180);
    }
    emit({}, "stop");
  }
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
let launched = false;
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        local: {
          api: "openai-completions",
          baseUrl,
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Fixture",
              reasoning: true,
              input: ["text"],
              contextWindow: 128000,
              maxTokens: 1024,
              cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
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
      defaultThinkingLevel: "off",
      compaction: { enabled: false },
      retry: { enabled: false },
      quietStartup: true,
    }),
  );
  const extension = join(directory, "runtime-fixture.mjs");
  await writeFile(
    extension,
    `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = ${JSON.stringify(directory)};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function hold(name) {
  writeFileSync(join(root, name + ".started"), "started");
  for (let n = 0; n < 1000 && !existsSync(join(root, name + ".release")); n++) await pause(20);
}
export default function(pi) {
  let context = false, ended = false, settled = false, message = false;
  pi.on("session_start", (_, ctx) => {
    ctx.ui.setStatus("runtime-ready", "RUNTIME_READY");
    writeFileSync(join(root, "muted.ansi"), ctx.ui.theme.getFgAnsi("muted"));
    pi.sendMessage({ customType: "fixture-history", content: Array.from({length: 70}, (_, n) => "History line " + n).join("\\n"), display: true }, {triggerTurn: false});
  });
  pi.on("context_with_system", async () => { if (!context) { context = true; await hold("context"); } });
  pi.on("turn_end", async () => { if (!ended) { ended = true; await hold("turn"); } });
  pi.on("tool_result", () => { const end = performance.now() + 350; while (performance.now() < end) {} });
  pi.on("message_end", async event => { if (!message && event.message.role === "assistant" && event.message.stopReason === "stop") { message = true; await hold("message"); } });
  pi.on("agent_before_settle", async () => { if (!settled) { settled = true; await hold("settle"); } });
  pi.registerTool({ name: "fixture_work", label: "Fixture work", description: "Integration fixture work.", parameters: { type: "object", properties: {} }, async execute() { await hold("tool"); return { content: [{ type: "text", text: "TOOL_OK" }], details: {} }; } });
}`,
  );
  const marker = (key) =>
    writeFile(join(directory, `${key}.release`), "release");
  terminal.start(
    `env NODE_OPTIONS=${quote(process.env.NODE_OPTIONS ?? "")} CPI_FORK=${quote(process.env.CPI_FORK ?? "")} JITI_ALIAS=${quote(process.env.JITI_ALIAS ?? "{}")} PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 CPI_CODING_AGENT_DIR=${quote(agentDir)} ${quote(process.execPath)} ${quote(piExecutableOnPath())} --approve --no-session --no-context-files --no-extensions --provider local --model fixture --tools fixture_work,wait_any -e ${quote(packagePath("src/core.ts"))} -e ${quote(packagePath("src/wait-any.ts"))} -e ${quote(extension)}`,
  );
  launched = true;
  await until("startup", (screen) => screen.includes("RUNTIME_READY"));
  send("Exercise all runtime states.");
  await until(
    "context",
    (screen) =>
      screen.includes("Waiting on harness") &&
      screen.includes("context_with_system") &&
      screen.includes("runtime-fixture.mjs"),
  );
  const pinned = captures.context
    .split("\n")
    .findIndex((line) => /^── [●◉○] Waiting on harness/.test(line));
  assert.ok(pinned >= 0);
  assert.doesNotMatch(captures.context, /↑0 ↓0 R0 CH0\.0%/);
  assert.match(captures.context.split("\n")[pinned], /\/128k ──$/);
  const color = await readFile(join(directory, "muted.ansi"), "utf8");
  const styled = terminal
    .capture(true)
    .split("\n")
    .find((line) => line.includes("Waiting on harness"));
  for (const code of color.match(/\x1b\[[0-9;]*m/g) ?? [])
    if (terminal.mode === "tmux" && code !== "\x1b[39m")
      assert.ok(
        styled.includes(code),
        `Expected muted status: ${JSON.stringify(styled)}`,
      );
  const frame = captures.context.split("\n")[pinned][3];
  await until(
    "animation",
    (screen) =>
      /^── [●◉○] Waiting on harness/m.test(screen) &&
      screen.split("\n")[pinned][3] !== frame,
  );
  terminal.key("PageUp");
  await until(
    "scrolled",
    (screen) =>
      screen.includes("History line") &&
      /^── [●◉○] Waiting on harness/m.test(screen),
  );
  assert.match(
    captures.scrolled.split("\n")[pinned],
    /^── [●◉○] Waiting on harness/,
  );
  terminal.key("PageDown");
  await marker("context");
  await until(
    "api",
    (screen) =>
      gates.has("api-1") &&
      screen.includes("API") &&
      screen.includes("Waiting for API response"),
  );
  release("api-1");
  await until("thinking", (screen) => /Thinking.*\d+ ch\/s/.test(screen));
  await until(
    "stream",
    (screen) =>
      gates.has("stream") &&
      screen.includes("API") &&
      screen.includes("Waiting for API stream"),
  );
  release("stream");
  await until("tool-writing", (screen) =>
    /Writing tool call.*\d+ ch\/s/.test(screen),
  );
  release("tool-writing");
  await until("tool", async (screen) => {
    try {
      await readFile(join(directory, "tool.started"));
    } catch {
      return false;
    }
    return (
      screen.includes("fixture_work") && !/Tools.*fixture_work/.test(screen)
    );
  });
  send("STEERING_DURING_TOOL");
  await until("queued", (screen) =>
    screen.includes("Steering: STEERING_DURING_TOOL"),
  );
  await marker("tool");
  await until(
    "turn",
    (screen) =>
      screen.includes("Waiting on harness") &&
      screen.includes("turn_end") &&
      screen.includes("runtime-fixture.mjs"),
  );
  assert.match(captures.turn, /event loop blocked 0\.[34]s/);
  await marker("turn");
  await until("writing", (screen) => /Writing reply.*\d+ ch\/s/.test(screen));
  await until(
    "message",
    (screen) =>
      /Waiting on harness.*message_end.*runtime-fixture.mjs/.test(screen) &&
      /last \d+ tok\/s avg/.test(screen),
  );
  assert.match(JSON.stringify(requests[1]), /STEERING_DURING_TOOL/);
  await marker("message");
  await until("settlement", (screen) =>
    /Waiting on harness.*agent_before_settle.*runtime-fixture.mjs/.test(screen),
  );
  await marker("settle");
  await until(
    "idle",
    (screen) =>
      screen.includes("RUNTIME_STATUS_VERIFIED") &&
      /^── ↑/m.test(screen) &&
      !/^── [●◉○] /m.test(screen),
  );
  send("Wait for an event.");
  await until("waiting", (screen) =>
    screen.includes("Waiting for your input or an event"),
  );
  send("Resume and then cancel.");
  await until(
    "resume",
    (screen) =>
      gates.has("api-4") && screen.includes("Waiting for API response"),
  );
  terminal.key("Escape");
  await until(
    "cancelled",
    (screen) =>
      /^── ↑/m.test(screen) &&
      !/^── [●◉○] /m.test(screen) &&
      !screen.includes("Waiting for API response"),
  );
  release("api-4");
  for (const key of [
    "context",
    "api",
    "thinking",
    "stream",
    "tool-writing",
    "turn",
    "writing",
    "message",
    "settlement",
    "waiting",
    "resume",
  ]) {
    const lines = captures[key].split("\n");
    assert.equal(
      lines.filter((line) => /^── [●◉○] /.test(line)).length,
      1,
      key,
    );
    assert.doesNotMatch(captures[key], /^── ↑|^[●◉○] /m, key);
  }
  assert.match(captures.tool, /^── ↑/m);
  assert.doesNotMatch(captures.tool, /^[●◉○] /m);
  send("/debug");
  await until("debug", (screen) => screen.includes("Debug log written"));
  const { APP_NAME } = await hostCodingAgent();
  const debug = await readFile(join(agentDir, `${APP_NAME}-debug.log`), "utf8");
  assert.match(debug, /Runtime activities/);
  assert.match(debug, /context_with_system.*runtime-fixture/);
  assert.match(debug, /agent_before_settle.*runtime-fixture/);
  assert.match(debug, /maxMs/);
  assert.match(debug, /maxSyncMs/);
  await writeFile(
    join(directory, "captures.json"),
    JSON.stringify(captures, null, 2),
  );
  console.log(
    `PASS actual TUI: embedded status replaces usage, idle/cancel restore usage, muted animation, scrolling, context, API, thinking/writing reply/tool call ch/s, provider average tok/s, hidden tool activity, queued steering, blocking handlers, waiting, and debug timings. Artifacts: ${directory}`,
  );
} finally {
  for (const key of [...gates.keys()]) release(key);
  if (launched) terminal.stop();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  restore();
}
