import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { runForkProbe } from "../../extensions/lib/fork-probe.ts";
import { stopSubagentRpc } from "../../extensions/lib/subagent-rpc.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-probe-test-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
const marker = join(root, "marker");
writeFileSync(marker, "probe integration marker");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CPI_STATUS_REPORT_TURNS ??= "1";
delete process.env.CPI_FORK_PROBE;
let mode = "text";
let requests: any[] = [];
let mainRequests = 0;
let release: (() => void) | undefined;
let arrived: (() => void) | undefined;
let gate: Promise<void> | undefined;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body);
  const last = JSON.stringify(body.messages.at(-1));
  const summary = last.includes("Describe in one sentence");
  if (summary && gate) {
    arrived?.();
    await gate;
  }
  if (mode === "error") {
    response.writeHead(400);
    response.end("deliberate failure");
    return;
  }
  const tool =
    mode === "tool" ||
    (mode === "blocking" && !summary && ++mainRequests === 1);
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_read",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: marker }),
            },
          },
        ],
      }
    : {
        role: "assistant",
        content: summary ? "I'm testing blocking probes." : "PROBE_OK",
      };
  const chunk = (delta: any, finish_reason: string | null) =>
    `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "probe-test", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.end(
    chunk(delta, null) +
      chunk({}, tool ? "tool_calls" : "stop") +
      "data: [DONE]\n\n",
  );
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
const model = (
  id: string,
  input: number,
  contextWindow = 128000,
  tiers?: any[],
) => ({
  id,
  name: id,
  reasoning: true,
  input: ["text"],
  contextWindow,
  maxTokens: 1024,
  cost: {
    input,
    output: 1,
    cacheRead: 1,
    cacheWrite: 1,
    ...(tiers ? { tiers } : {}),
  },
});
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      local: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [
          model("probe-test", 10),
          model("cheap", 0.2),
          model("equal", 1),
          model("expensive", 2),
          model("unknown", 0),
          model("small", 0.2, 2048),
          model("tiered", 0.2, 128000, [
            {
              inputTokensAbove: 1000,
              input: 2,
              output: 1,
              cacheRead: 0.1,
              cacheWrite: 1,
            },
          ]),
        ],
      },
      foreign: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [model("foreign-only", 0.1)],
      },
    },
  }),
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "local",
    defaultModel: "probe-test",
    defaultThinkingLevel: "off",
    compaction: { enabled: false },
  }),
);
const parent = SessionManager.create(root, join(root, "sessions"));
parent.appendModelChange("local", "probe-test");
parent.appendThinkingLevelChange("high");
parent.appendMessage({
  role: "user",
  content: "Test fork probes.",
  timestamp: Date.now(),
});
parent.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "Ready." }],
  api: "openai-completions",
  provider: "local",
  model: "probe-test",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: "stop",
  timestamp: Date.now(),
});
const original = readFileSync(parent.getSessionFile()!, "utf8");
const options = {
  parentSessionFile: parent.getSessionFile()!,
  cwd: root,
  timeoutMs: 20000,
};
let session: any;
try {
  const text = await runForkProbe(options, "Recall your context.");
  assert.equal(text.ok, true, JSON.stringify(text));
  assert.equal(text.answer, "PROBE_OK");
  assert.equal(requests.length, 1);
  assert.ok(requests[0].tools.length > 0);
  const probeTools = requests[0].tools;
  console.log("PASS real fork worker: one response, tools preserved");
  mkdirSync(join(root, ".pi"));
  const configPath = join(root, ".pi", "cpi-config.json");
  const rule = (to: string, from = "probe-test") => ({ from, to });
  const cases: [string, unknown, string, string?][] = [
    ["cheap", [rule("cheap:medium")], "cheap"],
    ["equal cache price", [rule("equal:medium")], "probe-test"],
    ["expensive", [rule("expensive:medium")], "probe-test"],
    ["unknown price", [rule("unknown:medium")], "probe-test"],
    ["smaller context", [rule("small:medium")], "probe-test"],
    ["expensive tier", [rule("tiered:medium")], "probe-test"],
    ["foreign provider", [rule("foreign-only:medium")], "probe-test"],
    ["no fuzzy lookup", [rule("che:medium")], "probe-test"],
    ["unmatched", [rule("cheap:medium", "other")], "probe-test"],
    ["disabled", [], "probe-test"],
    ["identity", [rule("probe-test:high")], "probe-test"],
    ["invalid", [{ from: 7, to: "cheap:medium" }], "probe-test"],
    [
      "bounded",
      Array.from({ length: 33 }, () => rule("cheap:medium")),
      "probe-test",
    ],
    ["fallthrough", [rule("equal:medium"), rule("cheap:medium")], "cheap"],
    [
      "explicit model",
      [rule("cheap:medium")],
      "probe-test",
      "local/probe-test:high",
    ],
  ];
  for (const [label, substitutions, expected, explicit] of cases) {
    writeFileSync(configPath, JSON.stringify({ forkProbe: { substitutions } }));
    requests = [];
    const result = await runForkProbe(
      { ...options, model: explicit },
      "Recall your context.",
    );
    assert.equal(result.ok, true, `${label}: ${JSON.stringify(result)}`);
    assert.equal(requests.length, 1, label);
    assert.equal(requests[0].model, expected, label);
    assert.equal(
      requests[0].reasoning_effort,
      expected === "cheap" ? "medium" : "high",
      label,
    );
    assert.deepEqual(requests[0].tools, probeTools, label);
    assert.equal(readFileSync(parent.getSessionFile()!, "utf8"), original);
    console.log(`PASS substitution: ${label}`);
  }
  writeFileSync(
    configPath,
    JSON.stringify({ forkProbe: { substitutions: [] } }),
  );
  mode = "tool";
  requests = [];
  const tool = await runForkProbe(
    { ...options, tools: "read" },
    "Read the marker.",
  );
  assert.equal(requests.length, 1, JSON.stringify(tool));
  assert.equal(tool.ok, false);
  console.log("PASS real tool call: one turn, no continuation");
  mode = "error";
  requests = [];
  const error = await runForkProbe(options, "Return an answer.");
  assert.equal(error.ok, false);
  assert.equal(requests.length, 1);
  assert.equal(readFileSync(parent.getSessionFile()!, "utf8"), original);
  console.log("PASS failed probe: no agent retry; parent unchanged");

  const extension = join(root, "status-extension.ts");
  writeFileSync(
    extension,
    `import { setupStatusReports, disposeStatusReports, statusReportTurnStarted, statusReportTurnEnded } from ${JSON.stringify(resolve("extensions/lib/status-report.ts"))};
export default function(pi) {
pi.on("session_start", (_, ctx) => setupStatusReports(ctx));
pi.on("session_shutdown", () => disposeStatusReports());
pi.on("turn_start", (event, ctx) => statusReportTurnStarted(event, ctx));
pi.on("turn_end", (event, ctx) => statusReportTurnEnded(event, ctx));
}`,
  );
  const services = await createAgentSessionServices({
    cwd: root,
    agentDir,
    resourceLoaderOptions: {
      additionalExtensionPaths: [extension],
      noExtensions: true,
    },
  });
  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(root, join(root, "main")),
    tools: ["read"],
  }));
  await session.bindExtensions({
    mode: "tui",
    onError: (error: any) => {
      throw new Error(JSON.stringify(error));
    },
  });
  mode = "blocking";
  requests = [];
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let finished = false;
  const pending = session.prompt("Read the marker then finish.").then(() => {
    finished = true;
  });
  const deadline = setTimeout(() => void session.abort(), 20000);
  try {
    await Promise.race([
      reached,
      pending.then(() => {
        throw new Error("main finished without status probe");
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
  assert.equal(mainRequests, 1);
  assert.equal(finished, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].tools, probeTools);
  release!();
  gate = undefined;
  await pending;
  assert.equal(mainRequests, 2);
  assert.equal(finished, true);
  console.log(
    "PASS real SDK lifecycle: main turn waits for fork before next model request",
  );
  mainRequests = 0;
  requests = [];
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cancelReached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const cancelled = session.prompt("Read the marker again.");
  const cancelDeadline = setTimeout(() => void session.abort(), 20000);
  try {
    await Promise.race([
      cancelReached,
      cancelled.then(() => {
        throw new Error("main finished without cancellable probe");
      }),
    ]);
    await session.abort();
    await cancelled;
    assert.equal(mainRequests, 1);
    assert.equal(requests.length, 2);
    console.log(
      "PASS parent abort cancels awaited fork without a continuation",
    );
  } finally {
    clearTimeout(cancelDeadline);
  }
} finally {
  release?.();
  if (session) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  await stopSubagentRpc();
  server.closeAllConnections();
  server.close();
  rmSync(root, { recursive: true, force: true });
}
