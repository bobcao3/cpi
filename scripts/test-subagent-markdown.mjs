import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SubagentObservation } from "../extensions/lib/subagent-observation.ts";
import {
  beginActivity,
  listActivities,
  readActivityTail,
} from "../extensions/lib/activity.ts";
import { createToolDisplay } from "../bin/subagent-display.mjs";

const directory = mkdtempSync(join(tmpdir(), "cpi-markdown-pairing-"));
const runId = randomUUID();
beginActivity({
  id: runId,
  kind: "subagent",
  status: "running",
  label: "markdown integration",
  started_at: Date.now(),
});
const observation = new SubagentObservation({
  runId,
  env: { PI_SESSION_DIR: directory },
});
let sequence = 0;
const chunks = [];
observation.options.onMarkdown = (chunk) => chunks.push(chunk);
function event(data) {
  Atomics.add(observation.credits, 0, 1);
  observation.receive({
    kind: "run_event",
    version: 1,
    runId,
    sequence: ++sequence,
    ...data,
  });
}
function call(id, name, args) {
  event({ type: "tool_call", id, name, args });
}
function result(id, name, lines, isError = false) {
  event({ type: "tool_result", id, name, lines, isError, rendering: "tui" });
}
let session;
try {
  call("first", "edit", { description: "first\n\n request", path: "first.ts" });
  call("second", "edit", { description: "second request", path: "second.ts" });
  assert.equal(
    chunks.join(""),
    "",
    "call headers must wait for their own result",
  );
  result("second", "edit", ["SECOND_RESULT"]);
  result("first", "edit", ["FIRST_RESULT"]);
  call("read-ok", "read", { path: "fixture.txt" });
  result("read-ok", "read", ["READ_SECRET_MUST_NOT_APPEAR"]);
  call("read-error", "read", { path: "missing.txt" });
  result("read-error", "read", ["READ_ERROR_BODY_MUST_NOT_APPEAR"], true);
  call("spaces", "sh", { description: "trim whitespace" });
  result("spaces", "sh", ["a   ", "", "   ", "", "b", "", ""]);
  call("unfinished", "edit", { path: "unfinished.ts" });
  event({
    type: "usage",
    scope: "self",
    usage: { input: 0, output: 0, cost: 0 },
    turns: 0,
  });
  event({ type: "terminal", outcome: "cancelled", answer: "" });
  assert.equal(observation.finish(null, true), undefined);
  const markdown = chunks.join("");
  assert.match(
    markdown,
    /\[edit\|2\]: second request · second\.ts\n> SECOND_RESULT\n\n\[edit\|1\]: first request · first\.ts\n> FIRST_RESULT/,
  );
  assert.match(markdown, /\[read\|3\]: fixture\.txt/);
  assert.match(markdown, /\[read\|4\]: missing\.txt \[error\]/);
  assert(!markdown.includes("MUST_NOT_APPEAR"));
  assert(!/\n\n\n|[ \t]+\n/.test(markdown), markdown);
  assert.match(markdown, /\[edit\|6\]: unfinished\.ts \[result unavailable\]/);
  assert.equal(markdown, readFileSync(observation.result.markdownPath, "utf8"));
  assert.equal(
    markdown,
    await readActivityTail(
      listActivities().find((entry) => entry.id === runId),
    ),
  );
  assert.equal(
    listActivities().find((entry) => entry.id === runId).status,
    "cancelled",
  );
  console.log(
    "PASS paired reverse-order same-tool results, hidden read bodies, whitespace, cancellation, identical durable/activity markdown",
  );

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    systemPrompt: "",
  });
  await loader.reload();
  const text = "é".repeat(65) + "\nSECOND_LINE_MUST_NOT_APPEAR";
  const tool = defineTool({
    name: "plain",
    label: "plain",
    description: "",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text }], details: {} }),
  });
  ({ session } = await createAgentSession({
    cwd: directory,
    modelRuntime: await ModelRuntime.create(),
    settingsManager,
    sessionManager: SessionManager.inMemory(directory),
    resourceLoader: loader,
    customTools: [tool],
    tools: ["plain"],
  }));
  const diagnostics = [];
  const display = createToolDisplay(session, (message) =>
    diagnostics.push(message),
  );
  display.call({ id: "plain-call", name: "plain", arguments: {} });
  const executed = await session.agent.state.tools
    .find((entry) => entry.name === "plain")
    .execute("plain-call", {});
  const rendered = display.result({
    ...executed,
    toolName: "plain",
    toolCallId: "plain-call",
    isError: false,
  });
  assert.deepEqual(rendered.lines, [
    "é".repeat(60) + `...[${Buffer.byteLength(text)} bytes]`,
  ]);
  assert.equal(rendered.rendering, "fallback");
  assert.deepEqual(diagnostics, []);
  console.log(
    "PASS actual SDK tool without renderer: first 60 Unicode characters plus full UTF-8 byte count",
  );
} finally {
  session?.dispose();
  observation.finish(null, true);
  rmSync(directory, { recursive: true, force: true });
}
