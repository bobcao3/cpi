#!/usr/bin/env node
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { analyzeCommand } from "../../extensions/shell/analyze.ts";
import { launchMonitor, ResumeClient } from "../../extensions/shell/monitor.ts";
import {
  ensureShellTools,
  getShuckBinPath,
  getToolEnv,
} from "../../extensions/shell/tools.ts";
import { resolveShell } from "../../extensions/shell/profile.ts";
import {
  setRepeatCompletionHook,
  setRepeatScopeGetter,
  startRepeat,
} from "../../extensions/shell/repeat.ts";

assert.equal(
  process.platform,
  "win32",
  "run this integration test on native Windows",
);
const shell = resolveShell("auto");
assert.equal(shell.dialect, "powershell");
assert.deepEqual(shell.commandArgs("ok").slice(0, -1), [
  "-NoLogo",
  "-NoProfile",
  "-NonInteractive",
  "-Command",
]);

const availability = await ensureShellTools();
assert(availability.fd, "fd provisioned");
assert(availability.rg, "rg provisioned");
const env = getToolEnv();

async function analyze(command: string) {
  return analyzeCommand({
    command,
    shell,
    availability,
    shuckPath: getShuckBinPath(),
  });
}

assert.equal((await analyze("Write-Output 'ok'")).errorCount, 0);
assert(
  (await analyze("Write-Output (")).errorCount > 0,
  "syntax failure blocked",
);
assert(
  (await analyze("iex $code")).errorCount > 0,
  "Invoke-Expression blocked",
);
assert(
  (await analyze("Remove-Item -Recurse -Force C:\\")).errorCount > 0,
  "root removal blocked",
);
assert(
  (await analyze("& $dynamic")).errorCount > 0,
  "dynamic invocation blocked",
);

async function monitor(command: string, id: string) {
  const handle = await launchMonitor(command, env, id, shell);
  await handle.client.stat();
  let text = "";
  let exitCode: number | undefined;
  await handle.client.subscribe((event) => {
    if (event.kind === "data") text += event.buf.toString("utf8");
    else exitCode = event.exitCode;
  });
  const deadline = Date.now() + 15_000;
  while (exitCode === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!text) text = await readFile(handle.logPath, "utf8");
  handle.client.close();
  assert.notEqual(exitCode, undefined, "monitor completed before deadline");
  return { text, exitCode };
}

const foreground = await monitor(
  "Write-Output 'monitor-ok'",
  `win-fg-${Date.now()}`,
);
assert.equal(foreground.exitCode, 0);
assert.match(foreground.text, /monitor-ok/);

const resumeHandle = await launchMonitor(
  "Start-Sleep -Milliseconds 500; Write-Output 'resume-ok'",
  env,
  `win-resume-${Date.now()}`,
  shell,
);
await resumeHandle.client.stat();
const pipe = await resumeHandle.client.bindResume();
assert(
  pipe?.startsWith("\\\\.\\pipe\\cpi-sh-mon-"),
  "named-pipe resume endpoint",
);
resumeHandle.client.close();
const resumed = new ResumeClient(pipe!);
await resumed.whenReady;
let resumedText = "";
let resumedExit: number | undefined;
resumed.subscribe((event) => {
  if (event.kind === "data") resumedText += event.buf.toString("utf8");
  else resumedExit = event.exitCode;
});
const resumeDeadline = Date.now() + 15_000;
while (resumedExit === undefined && Date.now() < resumeDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
resumed.close();
assert.equal(resumedExit, 0);
assert.match(resumedText, /resume-ok/);

const killHandle = await launchMonitor(
  "$p=Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 60' -PassThru; Write-Output $p.Id; Wait-Process $p.Id",
  env,
  `win-kill-${Date.now()}`,
  shell,
);
await killHandle.client.stat();
let childPid = 0;
let killed = false;
await killHandle.client.subscribe((event) => {
  if (event.kind === "data") {
    const match = event.buf.toString("utf8").match(/\d+/);
    if (match) childPid = Number(match[0]);
  } else killed = true;
});
const pidDeadline = Date.now() + 5000;
while (!childPid && Date.now() < pidDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
assert(childPid > 0, "spawned child PID observed");
killHandle.client.sendSignal("SIGINT");
const killDeadline = Date.now() + 10_000;
while (!killed && Date.now() < killDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
killHandle.client.close();
assert(killed, "terminated process tree completed");
assert.throws(
  () => process.kill(childPid, 0),
  "PowerShell grandchild terminated",
);

setRepeatScopeGetter(() => "windows-integration");
let repeatTimer: ReturnType<typeof setTimeout> | undefined;
const repeatCompletion = new Promise<{
  id: string;
  exitCode: number;
  reason: string;
  logPath: string;
}>((resolve, reject) => {
  repeatTimer = setTimeout(
    () => reject(new Error("repeat did not complete before deadline")),
    10_000,
  );
  setRepeatCompletionHook((id, _command, code, reason, log) => {
    if (repeatTimer) clearTimeout(repeatTimer);
    resolve({
      id,
      exitCode: code ?? -1,
      reason,
      logPath: log?.path ?? "",
    });
  });
});
const repeatId = startRepeat(
  "Write-Output 'repeat-ok'; exit 7",
  5,
  env,
  undefined,
  shell,
);
const repeat = await repeatCompletion;
assert.equal(repeat.id, repeatId);
assert.equal(repeat.exitCode, 7);
assert.equal(repeat.reason, "stopped");
assert.match(await readFile(repeat.logPath, "utf8"), /repeat-ok/);

process.stdout.write("windows shell integration ok\n");
