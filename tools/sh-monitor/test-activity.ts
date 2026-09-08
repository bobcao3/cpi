import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  listActivities,
  readActivityTail,
} from "../../extensions/lib/activity.ts";
import {
  detachChild,
  killAll,
  runShell,
  setCurrentScope,
  signalChild,
  silenceChild,
  resumeBackgroundShells,
} from "../../extensions/shell/exec.ts";
import { startRepeat, signalRepeat } from "../../extensions/shell/repeat.ts";
import { launchMonitor, writeResumeRecord } from "../../extensions/shell/monitor.ts";

const scope = `activity-${Date.now()}`;
const directory = await mkdtemp(join(tmpdir(), "cpi-activity-"));
const env = { ...process.env, PI_SESSION_ID: scope, PI_SESSION_DIR: directory };
setCurrentScope(scope);
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await delay(25);
  }
  assert.fail(
    `activity transition timeout: ${JSON.stringify(listActivities(scope))}`,
  );
}
const run = (command: string) =>
  runShell(
    command,
    0.02,
    env,
    undefined,
    undefined,
    command,
    30,
    { maxLines: 100 },
    { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 100 },
  );
function shell(pid: string) {
  const entry = listActivities(scope).find(
    (entry) => entry.kind === "shell" && entry.metrics?.pid === Number(pid),
  );
  assert.ok(entry);
  return entry;
}
try {
  const completed = await run("echo activity-output; sleep 0.15; exit 7");
  assert.ok(completed.id);
  assert.equal(shell(completed.id).status, "running");
  await until(() => shell(completed.id!).status === "failed");
  assert.equal(shell(completed.id).metrics?.exit_code, 7);
  assert.match(await readActivityTail(shell(completed.id)), /activity-output/);
  assert.ok(Number(shell(completed.id).metrics?.output_bytes) > 0);

  const cancelled = await run("echo ready; sleep 30");
  assert.ok(cancelled.id);
  assert.equal(signalChild(cancelled.id, "SIGKILL"), true);
  silenceChild(cancelled.id);
  assert.equal(shell(cancelled.id).status, "stopping");
  await until(() => shell(cancelled.id!).status === "cancelled");

  const killed = await run("sleep 30");
  assert.ok(killed.id);
  killAll();
  await until(() => shell(killed.id!).status === "cancelled");

  const marker = join(directory, "detached-finished");
  const detached = await run(`sleep 0.15; echo survived > '${marker}'`);
  assert.ok(detached.id);
  assert.ok(detachChild(detached.id));
  assert.equal(shell(detached.id).status, "detached");
  await delay(250);
  assert.match(await readFile(marker, "utf8"), /survived/);
  assert.equal(shell(detached.id).status, "detached");
  assert.equal(signalChild(detached.id, "SIGKILL"), false);

  const handle = await launchMonitor("sleep 0.3; echo resumed", env, `${Date.now()}-activity-resume`);
  const resumedId = String((await handle.client.stat()).pid);
  const socket = await handle.client.bindResume();
  assert.ok(socket);
  await writeResumeRecord(directory, scope, resumedId, socket, "resume", handle.logPath);
  handle.client.orphan();
  await resumeBackgroundShells(directory, scope);
  assert.equal(shell(resumedId).metrics?.resumed, 1);
  await until(() => shell(resumedId).status === "completed");

  const repeat = startRepeat("echo iteration", 1, env, "waiting monitor");
  const monitor = () =>
    listActivities(scope).find(
      (entry) => entry.kind === "monitor" && entry.label === "waiting monitor",
    )!;
  await until(() => monitor()?.metrics?.phase === "waiting");
  assert.equal(monitor().metrics?.invocation, 1);
  assert.ok(Number(monitor().metrics?.next_due_at) > Date.now());
  assert.ok(signalRepeat(repeat, "SIGKILL"));
  assert.equal(monitor().status, "cancelled");

  const executing = startRepeat(
    "echo running; sleep 30",
    1,
    env,
    "executing monitor",
  );
  const activeMonitor = () =>
    listActivities(scope).find((entry) => entry.label === "executing monitor")!;
  assert.ok(signalRepeat(executing, "SIGKILL"));
  assert.equal(activeMonitor().status, "stopping");
  await until(() => activeMonitor().status === "cancelled");

  startRepeat("exit 3", 1, env, "failed monitor");
  await until(() =>
    listActivities(scope).some(
      (entry) => entry.label === "failed monitor" && entry.status === "failed",
    ),
  );
  setCurrentScope("other-session");
  assert.deepEqual(listActivities("other-session"), []);
  assert.ok(listActivities(scope).length >= 8);
  console.log(
    "PASS shell completion/cancel/killAll/detach/resume; monitor wait/cancel/failure; scope",
  );
} finally {
  setCurrentScope(scope);
  killAll();
  await delay(100);
  await rm(directory, { recursive: true, force: true });
}
