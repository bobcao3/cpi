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
import { execFileSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import {
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { buildFooterRows } from "../../extensions/lib/footer-rows.ts";
import { getSubagentUsage } from "../../extensions/lib/cost-ledger.ts";
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
delete process.env.CPI_COST_SOCKET;
delete process.env.CPI_COST_RUN_ID;
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
  pi.on("session_tree", (_, ctx) => setupStatusReports(ctx));
  pi.on("session_shutdown", () => disposeStatusReports());
  pi.on("turn_start", (event, ctx) => statusReportTurnStarted(event, ctx));
  pi.on("turn_end", (event, ctx) => statusReportTurnEnded(pi, event, ctx));
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
    extensions: [
      resolve("extensions/cwd.ts"),
      resolve("extensions/cost-tree/index.ts"),
      extension,
    ],
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
    toolsDisabledMessage: "Tools are unavailable during this probe.",
    maxOutputTokens: 1024,
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
  assert.ok(
    file,
    JSON.stringify({
      result,
      error: result.error?.message,
      stderr,
      sessionDir,
    }),
  );
  const messages = SessionManager.open(
    join(sessionDir, file),
  ).buildSessionContext().messages;
  assert.equal(stdout, "", "stdout is not the worker observation protocol");
  return {
    result,
    answer: result.observation?.finalAnswer ?? "",
    stderr,
    messages,
  };
}
try {
  const completed = await probe("Describe your current status without tools.");
  const last = completed.messages.at(-1);
  assert.ok(last?.role === "custom");
  assert.equal(last.customType, "cwd-reminder", JSON.stringify(completed));
  assert.equal(completed.result.exitCode, 0, completed.stderr);
  assert.equal(
    completed.answer.trim(),
    answer,
    "summary lost behind real cwd reminder",
  );
  console.log("PASS summary survives production cwd reminder after assistant");
  const handled = await probe("NO_MODEL");
  assert.equal(handled.answer, "");
  assert.notEqual(handled.result.exitCode, 0);
  console.log("PASS handled prompt cannot return inherited assistant text");
  fail = true;
  const failed = await probe("Describe status.");
  assert.equal(failed.answer, "");
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
    answer,
  );
  const theme = getThemeByName("dark")!;
  const summary = sections.filter((section: any) => section.name === "summary");
  for (const effort of ["off", "low", "high", "xhigh"] as const) {
    const line = buildFooterRows(160, theme, summary, effort).component.render(
      160,
    )[0];
    assert.equal(stripVTControlCharacters(line).trim(), answer);
    assert.ok(line.includes(theme.getThinkingBorderColor(effort)(answer)));
    assert.doesNotMatch(line, /\x1b\[(?:48[;:]|4[0-7]m|10[0-7]m)/);
  }
  for (const width of [40, 160]) {
    const rows = buildFooterRows(width, theme, sections, "high")
      .component.render(width)
      .map(stripVTControlCharacters);
    assert.ok(rows.join("\n").includes("I'm auditing documentation"));
  }
  console.log(
    "PASS real status hook publishes returned probe into rendered footer",
  );
  const probe_usage = getSubagentUsage();
  assert.equal(
    probe_usage.count,
    1,
    "Worker observation and socket reports counted the same probe twice",
  );
  assert(probe_usage.input > 0 && probe_usage.cost > 0);
  const summary_value = () =>
    (globalThis as any).__cpiFooter.segments
      .find((segment: any) => segment.name === "summary")
      ?.produce();
  const summary_file = session.sessionManager.getSessionFile();
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from "node:assert/strict";
    import { hostCodingAgent } from ${JSON.stringify(resolve("bin/host-pi.mjs"))};
    import { getSubagentUsage } from ${JSON.stringify(resolve("extensions/lib/cost-ledger.ts"))};
    delete process.env.CPI_COST_SOCKET;
    delete process.env.CPI_COST_RUN_ID;
    const { SessionManager, createAgentSessionServices, createAgentSessionFromServices } = await hostCodingAgent();
    const { session } = await createAgentSessionFromServices({
      services: await createAgentSessionServices({ cwd: ${JSON.stringify(root)}, agentDir: ${JSON.stringify(agentDir)} }),
      sessionManager: SessionManager.open(${JSON.stringify(summary_file)}),
    });
    await session.bindExtensions({ mode: "tui", onError: error => { throw new Error(error.error); } });
    assert.equal(globalThis.__cpiFooter.segments.find(segment => segment.name === "summary")?.produce(), ${JSON.stringify(answer)});
    assert.deepEqual(getSubagentUsage(), ${JSON.stringify(probe_usage)});
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  `,
    ],
    { timeout: 20000 },
  );
  const summary_leaf = session.sessionManager.getLeafId();
  const earlier_leaf = session.sessionManager
    .getBranch()
    .find(
      (entry: any) =>
        entry.type === "message" && entry.message.role === "assistant",
    ).id;
  await session.reload();
  assert.equal(
    summary_value(),
    answer,
    "reload discarded the published summary",
  );
  assert.deepEqual(
    getSubagentUsage(),
    probe_usage,
    "Reload changed persisted probe accounting",
  );
  await session.navigateTree(earlier_leaf);
  assert.equal(
    summary_value(),
    null,
    "summary leaked from an abandoned branch",
  );
  await session.navigateTree(summary_leaf);
  assert.equal(summary_value(), answer);
  await session.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  session.dispose();
  delete (globalThis as any).__cpiStatusReport;
  ({ session } = await createAgentSessionFromServices({
    services: await createAgentSessionServices({ cwd: root, agentDir }),
    sessionManager: SessionManager.open(summary_file),
  }));
  await session.bindExtensions({
    mode: "tui",
    onError: (error: any) => {
      throw new Error(JSON.stringify(error));
    },
  });
  assert.equal(
    summary_value(),
    answer,
    "resume discarded the persisted summary",
  );
  assert.deepEqual(
    getSubagentUsage(),
    probe_usage,
    "Resume changed persisted probe accounting",
  );
  console.log(
    "PASS summary survives reload and resume and follows tree navigation",
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
