import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  runSubagentWorker,
  ensureSubagentRpc,
  stopSubagentRpc,
} from "../extensions/lib/subagent-rpc.ts";
import {
  listActivities,
  readActivityTail,
} from "../extensions/lib/activity.ts";
import { createMarkdownWriter } from "../extensions/lib/subagent-markdown.ts";
import { runSubagent as runEditorSubagent } from "../extensions/llm-editor/subagent.ts";

const directory = mkdtempSync(join(tmpdir(), "cpi-observation-live-"));
const provider = process.env.CPI_TEST_PROVIDER || "openai-codex";
const modelId = process.env.CPI_TEST_MODEL || "gpt-5.6-luna";
delete process.env.CPI_SUBAGENT_RPC;
const env = { ...process.env, PI_SESSION_DIR: directory };
for (const key of [
  "PI_SUBAGENT_ROLE",
  "PI_SUBAGENT_COMPLETION",
  "CPI_FORK_PROBE",
  "PI_SUBAGENT_SUMMARY",
])
  delete env[key];
const fixture = join(directory, "fixture.txt");
writeFileSync(fixture, "OBSERVATION_CONTENT\n\n\nsecond line\n");
const request = () => ({
  version: 1,
  kind: "session",
  runId: randomUUID(),
  cwd: process.cwd(),
  env,
  extensionPaths: [],
  tools: ["read"],
  systemPrompt: "Follow the task concisely.",
  task: `Read ${fixture} with the read tool, then reply exactly FIRST_DONE.`,
  provider,
  modelId,
  thinkingLevel: "off",
  outputMode: "text",
  maxTurns: 2,
  maxOutputBytes: 4096,
});
const mode = process.argv[2] || "session";
try {
  if (mode === "session") {
    const chunks = [];
    const events = [];
    const input = request();
    const result = await runSubagentWorker(input, {
      signal: AbortSignal.timeout(120000),
      onMarkdown: (chunk) => chunks.push(chunk),
      onEvent: (event) => events.push(event),
      onMessage: (candidate) =>
        candidate.turn === 0
          ? {
              kind: "continue",
              prompt: "Reply exactly SECOND_DONE without tools.",
            }
          : { kind: "finish" },
      stderr: (chunk) => process.stderr.write(chunk),
    });
    assert.equal(result.error, undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.observation.finalAnswer.trim(), "SECOND_DONE");
    assert.equal(events.filter((event) => event.type === "terminal").length, 1);
    assert.equal(events.at(-2).type, "usage");
    assert.equal(events.at(-1).outcome, "completed");
    assert(
      events
        .filter((event) => event.type === "session")
        .every((event) => event.sessionFile === null),
    );
    assert(
      events.some(
        (event) => event.type === "tool_call" && event.args.path === fixture,
      ),
    );
    assert(
      events.some(
        (event) => event.type === "tool_result" && event.rendering === "tui",
      ),
    );
    assert(result.observation.usage.output > 0);
    const markdown = chunks.join("");
    assert(
      !markdown.includes("OBSERVATION_CONTENT"),
      "read result leaked into markdown",
    );
    assert(markdown.includes(fixture), "read call summary is missing");
    assert.equal(
      readFileSync(result.observation.markdownPath, "utf8"),
      markdown,
    );
    const activity = listActivities().find((entry) => entry.id === input.runId);
    assert.equal(await readActivityTail(activity), markdown);
    assert.equal(activity.metrics.usage_scope, "self");
    assert(!/^jsonl:|^summary:/m.test(markdown));
    assert(!/\n\n\n/.test(markdown));
    assert(!markdown.startsWith("\n") && !markdown.endsWith("\n\n"));
    assert.equal(
      markdown
        .split("## Assistant")
        .at(-1)
        .match(/SECOND_DONE/g)?.length,
      1,
    );
    writeFileSync(result.observation.markdownPath, "MUST_NOT_BE_TAILED");
    assert.equal(await readActivityTail(activity), markdown);
    writeFileSync(result.observation.markdownPath, markdown);
    console.log(
      "PASS live SDK correction, TUI result, usage, shared durable markdown, no file tail",
      result.observation,
    );
  } else if (mode === "cli") {
    const endpoint = await ensureSubagentRpc();
    const child = spawn(
      process.execPath,
      [resolve("bin/subagent.js"), "-m", `${provider}/${modelId}:off`],
      {
        env: { ...env, CPI_SUBAGENT_RPC: endpoint },
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    child.stdin.end("Reply exactly CLI_OBSERVATION_OK without tools.\n");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    const activity = listActivities().find(
      (entry) => entry.kind === "subagent",
    );
    assert.equal(activity.status, "completed");
    assert.equal(
      readFileSync(activity.log_path, "utf8"),
      await readActivityTail(activity),
    );
    assert(activity.metrics.session_file.endsWith(".jsonl"));
    console.log(
      "PASS live CLI launcher and persisted session",
      activity.log_path,
    );
  } else if (mode === "fork") {
    const parent = SessionManager.create(
      process.cwd(),
      join(directory, "parent"),
    );
    parent.appendModelChange(provider, modelId);
    parent.appendMessage({
      role: "user",
      content: "Keep replies concise.",
      timestamp: Date.now(),
    });
    parent.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "INHERITED_MUST_NOT_LEAK" }],
      api: "openai-codex-responses",
      provider,
      model: modelId,
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
    const events = [];
    const result = await runSubagentWorker(
      {
        version: 1,
        kind: "fork-probe",
        parentSessionFile: parent.getSessionFile(),
        parentSessionId: parent.getSessionId(),
        sessionDir: join(directory, "fork"),
        prompt: "Reply exactly FORK_OBSERVATION_OK without tools.",
        toolsDisabledMessage: "Tools are unavailable.",
        maxOutputTokens: 1024,
        cwd: process.cwd(),
        env,
        runId: randomUUID(),
        model: `${provider}/${modelId}:off`,
      },
      {
        signal: AbortSignal.timeout(120000),
        onEvent: (event) => events.push(event),
        stderr: (chunk) => process.stderr.write(chunk),
      },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.observation.finalAnswer.trim(), "FORK_OBSERVATION_OK");
    assert(
      !readFileSync(result.observation.markdownPath, "utf8").includes(
        "INHERITED_MUST_NOT_LEAK",
      ),
    );
    assert.equal(events.filter((event) => event.type === "terminal").length, 1);
    console.log("PASS live fork structured answer", result.observation);
  } else if (mode === "viewer" || mode === "editor") {
    const result = await runEditorSubagent({
      role: mode,
      title: "Observation integration",
      systemPrompt: "Reply concisely.",
      task:
        mode === "viewer"
          ? "Reply exactly VIEWER_OBSERVATION_OK."
          : "Call edit-complete with content EDITOR_COMPLETION_OK.",
      provider,
      modelId,
      thinkingLevel: "off",
      outputMode: mode === "viewer" ? "text" : "tool-call",
      maxCorrectionTurns: mode === "editor" ? 1 : 0,
      onCandidate: (candidate) =>
        mode === "editor" && candidate.turn === 0
          ? "Call edit-complete again, now with content EDITOR_CORRECTED_OK."
          : undefined,
      cwd: process.cwd(),
      timeoutMs: 120000,
      transcriptDir: join(directory, "audit"),
      id: randomUUID(),
      maxTranscripts: 10,
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    if (mode === "viewer")
      assert.equal(result.text.trim(), "VIEWER_OBSERVATION_OK");
    else assert.equal(result.completion.args.content, "EDITOR_CORRECTED_OK");
    assert(result.usage.output > 0);
    const activity = listActivities().find(
      (entry) => entry.metrics.role === mode,
    );
    assert(activity.log_path.endsWith(".md"));
    assert(activity.metrics.correction_audit_path !== activity.log_path);
    assert.equal(
      readFileSync(activity.log_path, "utf8"),
      await readActivityTail(activity),
    );
    assert.equal(activity.metrics.session_file, "");
    console.log(
      `PASS actual ${mode} client shares writer and keeps audit separate`,
      activity.log_path,
    );
  } else if (mode === "custom") {
    const events = [];
    const result = await runSubagentWorker(
      {
        ...request(),
        extensionPaths: [
          resolve("extensions/shell.ts"),
          resolve("extensions/lsp.ts"),
        ],
        tools: ["sh"],
        task: "Make two sh tool calls in the SAME assistant response: description 'First fixture', command 'printf FIRST_DISPLAY_OK'; description 'Second fixture', command 'printf SECOND_DISPLAY_OK'. Then reply DONE.",
        maxTurns: 1,
      },
      {
        signal: AbortSignal.timeout(120000),
        onMessage: () => ({ kind: "finish" }),
        onEvent: (event) => events.push(event),
        stderr: (chunk) => process.stderr.write(chunk),
      },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    const output = events.find((event) => event.type === "tool_result");
    assert.equal(output.rendering, "tui", JSON.stringify(events));
    const markdown = readFileSync(result.observation.markdownPath, "utf8");
    assert(!/<sh_result|<tool_result|<stdout/.test(markdown), markdown);
    const calls = events.filter((event) => event.type === "tool_call");
    assert.equal(calls.length, 2, JSON.stringify(events));
    for (const call of calls) {
      assert.equal(
        call.args.command,
        undefined,
        "raw tool arguments crossed observation boundary",
      );
      const label = call.args.description;
      const start = markdown.indexOf(`]: ${label}`);
      assert(start >= 0, markdown);
      const end = markdown.indexOf("\n\n", start);
      const block = markdown.slice(start, end < 0 ? undefined : end);
      assert(
        block.includes(
          label === "First fixture" ? "FIRST_DISPLAY_OK" : "SECOND_DISPLAY_OK",
        ),
        block,
      );
    }
    console.log("PASS real paired sh TUI result blocks", markdown);
  } else if (mode === "abort" || mode === "exit") {
    const events = [];
    const input = request();
    const controller = new AbortController();
    if (mode === "exit") {
      const extension = join(directory, "exit.ts");
      writeFileSync(
        extension,
        'export default function(pi) { pi.on("session_start", () => process.exit(0)); }',
      );
      input.extensionPaths = [extension];
    } else
      input.task =
        "List integers from one through one thousand, spelling each number in words.";
    const result = await runSubagentWorker(input, {
      signal: controller.signal,
      onMessage: () => ({ kind: "finish" }),
      onEvent: (event) => {
        events.push(event);
        if (mode === "abort" && event.type === "text") controller.abort();
      },
      stderr: (chunk) => process.stderr.write(chunk),
    });
    assert.equal(events.filter((event) => event.type === "terminal").length, 1);
    assert.equal(events.at(-2).type, "usage");
    assert.equal(
      events.at(-1).outcome,
      mode === "abort" ? "cancelled" : "failed",
    );
    assert.equal(result.exitCode, mode === "abort" ? null : 1);
    console.log(`PASS actual Worker ${mode}`, result.observation);
  } else if (mode === "failure") {
    const events = [];
    const result = await runSubagentWorker(
      { ...request(), provider: "unavailable-observation-provider" },
      {
        signal: AbortSignal.timeout(20000),
        onEvent: (event) => events.push(event),
        stderr: (chunk) => process.stderr.write(chunk),
      },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(events.at(-1).outcome, "failed");
    assert.equal(events.at(-2).type, "usage");
    assert.equal(events.filter((event) => event.type === "terminal").length, 1);
    assert(readFileSync(result.observation.diagnosticsPath, "utf8").length > 0);
    console.log("PASS actual worker startup failure terminal and diagnostics");
  }
  const chunks = [];
  const writer = createMarkdownWriter((chunk) => chunks.push(chunk));
  for (const chunk of [
    "\n\n",
    "live",
    " token",
    "\n> ",
    "\n>",
    "\n\n",
    "next",
    "\n\n",
  ])
    writer.write(chunk);
  assert.equal(chunks.slice(0, 2).join(""), "live token");
  writer.close();
  assert.equal(chunks.join(""), "live token\n\nnext\n");
  const unicode = [];
  const unicodeWriter = createMarkdownWriter((chunk) => unicode.push(chunk));
  for (const chunk of [
    "\n\u00a0\n",
    "\ud83d",
    "\ude80",
    "\n\n",
    "x".repeat(131072),
    "\n\u00a0\n",
  ])
    unicodeWriter.write(chunk);
  assert.equal(unicode.join(""), "🚀\n\n" + "x".repeat(131072));
  unicodeWriter.close();
  console.log("PASS token streaming and quoted blank normalization", directory);
} finally {
  await stopSubagentRpc();
}
