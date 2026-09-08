import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runSubagentWorker, stopSubagentRpc, getSubagentRpc, type SessionSubagentRequest } from "../../extensions/lib/subagent-rpc.ts";
import { runShell, setCurrentScope } from "../../extensions/shell/exec.ts";
import { listActivities } from "../../extensions/lib/activity.ts";

const scope = `worker-activity-${randomUUID()}`;
const env = Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => typeof pair[1] === "string"));
env.PI_SESSION_ID = scope;
delete env.CPI_SUBAGENT_RPC;
const request = (modelId: string): SessionSubagentRequest => ({
  version: 1,
  kind: "session",
  extensionPaths: [],
  tools: [],
  provider: "openai-codex",
  modelId,
  systemPrompt: "Reply concisely.",
  task: "Reply only ACTIVITY_OK.",
  outputMode: "text",
  maxOutputBytes: 4096,
  maxTurns: 1,
  cwd: process.cwd(),
  runId: randomUUID(),
  env,
});
try {
  const invalid = request("cpi-nonexistent-model-for-activity-test");
  const result = await runSubagentWorker(invalid);
  assert.notEqual(result.exitCode, 0);
  const failed = listActivities(scope).find((entry) => entry.id === invalid.runId);
  assert.equal(failed?.status, "failed");
  assert.ok(failed?.ended_at);
  assert.ok(failed?.tail);
  console.log("PASS real worker startup failure retained with stderr");
  const interrupted = request("cpi-nonexistent-model-for-activity-test");
  const abort = new AbortController();
  const pending = runSubagentWorker(interrupted, { signal: abort.signal });
  abort.abort();
  assert.equal(listActivities(scope).find((entry) => entry.id === interrupted.runId)?.status, "stopping");
  await pending;
  assert.equal(listActivities(scope).find((entry) => entry.id === interrupted.runId)?.status, "cancelled");
  console.log("PASS real worker abort stopping until Worker exit");
  setCurrentScope(scope);
  const shell = await runShell("subagent -m openai-codex/cpi-nonexistent-model-for-activity-test <<'TASK'\nactivity-cli-link-check\nTASK", 3, { ...env, CPI_SUBAGENT_RPC: getSubagentRpc() }, undefined, undefined, "CLI link", 30, { maxLines: 100 }, { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 100 });
  assert.notEqual(shell.exitCode, 0);
  const cli = listActivities(scope).find((entry) => entry.label.includes("activity-cli-link-check"));
  assert.equal(cli?.status, "failed");
  assert.match(cli?.log_path ?? "", /pi-sh-output-/);
  console.log("PASS real CLI RPC worker links launching shell log and owner scope");
  if (process.env.CPI_ACTIVITY_MODEL) {
    const live = request(process.env.CPI_ACTIVITY_MODEL);
    let answer = "";
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 60000);
    const completed = await runSubagentWorker(live, {
      signal: controller.signal,
      onMessage(message: any) {
        assert.equal(message.kind, "candidate");
        answer = message.text;
        return { kind: "finish" };
      },
    });
    clearTimeout(deadline);
    assert.equal(completed.exitCode, 0, completed.error?.message);
    assert.match(answer, /ACTIVITY_OK/);
    const entry = listActivities(scope).find((entry) => entry.id === live.runId)!;
    assert.equal(entry.status, "completed");
    assert.ok(Number(entry.metrics?.turns) >= 1);
    assert.ok(Number(entry.metrics?.output) > 0);
    assert.ok(entry.metrics?.child_session_id);
    assert.equal(entry.metrics?.session_file, "");
    console.log(`PASS real model worker telemetry: ${JSON.stringify(entry.metrics)}`);
  }
} finally {
  await stopSubagentRpc();
}
