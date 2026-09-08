import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderFooterRows } from "../../extensions/lib/footer-rows.ts";
import {
  runSubagentWorker,
  stopSubagentRpc,
  type ForkProbeSubagentRequest,
} from "../../extensions/lib/subagent-rpc.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-probe-output-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.CPI_STATUS_REPORT_TURNS = "1";
delete process.env.CPI_FORK_PROBE;
const answer = "I'm auditing documentation and source comments.";
let fail = false;
const server = createServer(async (request, response) => {
  for await (const _chunk of request) {
  }
  if (fail) {
    response.writeHead(400);
    response.end("test failure");
    return;
  }
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [delta, finish_reason] of [
    [{ role: "assistant", content: answer }, null],
    [{}, "stop"],
  ]) {
    response.write(
      `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1, model: "probe-output", choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 2048, completion_tokens: 10, total_tokens: 2058 } })}\n\n`,
    );
  }
  response.end("data: [DONE]\n\n");
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
assert.ok(address && typeof address !== "string");
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      local: {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        api: "openai-completions",
        apiKey: "test",
        models: [
          {
            id: "probe-output",
            name: "probe-output",
            reasoning: false,
            input: ["text"],
            contextWindow: 4096,
            maxTokens: 512,
            cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
const extension = join(root, "status-test.ts");
writeFileSync(
  extension,
  `import { setupStatusReports, disposeStatusReports, statusReportTurnStarted, statusReportTurnEnded } from ${JSON.stringify(resolve("extensions/lib/status-report.ts"))};
export default function(pi) {
  pi.on("input", event => event.text === "NO_MODEL" ? { action: "handled" } : undefined);
  pi.on("session_start", (_, ctx) => setupStatusReports(ctx));
  pi.on("session_shutdown", () => disposeStatusReports());
  pi.on("turn_start", (event, ctx) => statusReportTurnStarted(event, ctx));
  pi.on("turn_end", (event, ctx) => statusReportTurnEnded(event, ctx));
}`,
);
writeFileSync(
  join(agentDir, "settings.json"),
  JSON.stringify({
    defaultProvider: "local",
    defaultModel: "probe-output",
    defaultThinkingLevel: "off",
    compaction: { enabled: false },
    retry: { enabled: false },
    extensions: [resolve("extensions/cwd.ts"), extension],
  }),
);
const parent = SessionManager.create(root, join(root, "parent"));
parent.appendModelChange("local", "probe-output");
parent.appendMessage({
  role: "user",
  content: "Audit the documentation.",
  timestamp: Date.now(),
});
parent.appendMessage({
  role: "assistant",
  content: [{ type: "text", text: "INHERITED_ANSWER_MUST_NOT_LEAK" }],
  api: "openai-completions",
  provider: "local",
  model: "probe-output",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const parentBytes = readFileSync(parent.getSessionFile()!, "utf8");
let session: any;
async function probe(prompt: string) {
  const sessionDir = join(root, randomUUID());
  mkdirSync(sessionDir);
  const request: ForkProbeSubagentRequest = {
    version: 1,
    kind: "fork-probe",
    parentSessionFile: parent.getSessionFile()!,
    parentSessionId: parent.getSessionId(),
    sessionDir,
    prompt,
    cwd: root,
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (pair): pair is [string, string] => typeof pair[1] === "string",
      ),
    ),
    runId: randomUUID(),
  };
  let stdout = "";
  let stderr = "";
  const result = await runSubagentWorker(request, {
    signal: AbortSignal.timeout(20000),
    stdout: (chunk) => {
      stdout += chunk;
    },
    stderr: (chunk) => {
      stderr += chunk;
    },
  });
  const file = readdirSync(sessionDir).find((name) => name.endsWith(".jsonl"))!;
  const messages = SessionManager.open(
    join(sessionDir, file),
  ).buildSessionContext().messages;
  return { result, stdout, stderr, messages };
}
try {
  const completed = await probe("Describe your current status without tools.");
  const last = completed.messages.at(-1);
  assert.ok(last?.role === "custom");
  assert.equal(last.customType, "cwd-reminder", JSON.stringify(completed));
  assert.equal(completed.result.exitCode, 0, completed.stderr);
  assert.equal(
    completed.stdout.trim(),
    answer,
    "summary lost behind real cwd reminder",
  );
  console.log("PASS summary survives production cwd reminder after assistant");
  const handled = await probe("NO_MODEL");
  assert.equal(handled.stdout, "");
  assert.notEqual(handled.result.exitCode, 0);
  console.log("PASS handled prompt cannot return inherited assistant text");
  fail = true;
  const failed = await probe("Describe status.");
  assert.equal(failed.stdout, "");
  assert.notEqual(failed.result.exitCode, 0);
  assert.equal(readFileSync(parent.getSessionFile()!, "utf8"), parentBytes);
  fail = false;
  console.log("PASS failed response cannot return inherited assistant text");
  const services = await createAgentSessionServices({ cwd: root, agentDir });
  ({ session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.create(root, join(root, "main")),
  }));
  await session.bindExtensions({
    mode: "tui",
    onError: (error: any) => {
      throw new Error(JSON.stringify(error));
    },
  });
  const deadline = setTimeout(() => void session.abort(), 20000);
  try {
    await session.prompt("Audit the documentation.");
  } finally {
    clearTimeout(deadline);
  }
  const footer = (globalThis as any).__cpiFooter;
  const sections = footer.segments
    .map((segment: any) => ({ name: segment.name, value: segment.produce() }))
    .filter((section: any) => section.value);
  assert.equal(
    sections.find((section: any) => section.name === "summary")?.value,
    `[ ${answer} ]`,
  );
  const theme = getThemeByName("dark")!;
  for (const width of [40, 160]) {
    const rows = renderFooterRows(width, theme, sections).lines.map(
      stripVTControlCharacters,
    );
    assert.ok(rows.join("\n").includes("I'm auditing documentation"));
  }
  console.log(
    "PASS real status hook publishes returned probe into rendered footer",
  );
} finally {
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
