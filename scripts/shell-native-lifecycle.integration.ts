import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  launchMonitor,
  reapLaunch,
  ResumeClient,
} from "../extensions/shell/ghostmux-client.ts";
import {
  ensureTargetDirectory,
  getSessionTarget,
  ghostmuxSocket,
  readTarget,
  resolveGhostmuxBinary,
  setTargetScope,
} from "../extensions/shell/ghostmux.ts";
import { resolveShell } from "../extensions/shell/profile.ts";
import { shellCommand } from "./shell-platform.mjs";

const execute = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), "cpi-native-shell-"));
const scope = `native-${Date.now()}`;
const env = { ...process.env, PI_SESSION_ID: scope };
const shell = resolveShell();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail("native shell lifecycle timed out");
}
setTargetScope(scope);
let crashPid: number | undefined;
try {
  const handle = await launchMonitor(
    shellCommand(
      "printf first; sleep .3; printf last; exit 9",
      "[Console]::Write('first'); Start-Sleep -Milliseconds 300; [Console]::Write('last'); exit 9",
    ),
    env,
    `${Date.now()}-native`,
    shell,
    directory,
  );
  await handle.client.whenReady;
  const initial = handle.client.target!;
  const metadata = await readFile(initial.statePath, "utf8");
  if (process.platform === "linux") {
    const status = await readFile(`/proc/${initial.pid}/status`, "utf8");
    assert.equal(
      Number(status.match(/^PPid:\s+(\d+)/m)![1]),
      initial.serverPid,
    );
    assert.equal(
      (
        await readFile(
          `/proc/${process.pid}/task/${process.pid}/children`,
          "utf8",
        )
      ).trim(),
      "",
    );
  }
  let exit: number | undefined;
  await handle.client.subscribe((event) => {
    if (event.kind === "exit") exit = event.exitCode;
  });
  await until(() => exit !== undefined);
  assert.equal(exit, 9);
  assert.equal(await readFile(initial.statePath, "utf8"), metadata);
  const final = await readTarget(initial.statePath);
  assert.equal(final.bytes, 9);
  assert.equal(final.exitCode, 9);
  assert.equal(await readFile(final.logPath, "utf8"), "firstlast");
  handle.client.close();
  assert.equal((await getSessionTarget(initial.uid)).exitCode, 9);
  await assert.rejects(getSessionTarget(String(initial.pid)), /completed/);
  setTargetScope(`${scope}-other`);
  await assert.rejects(getSessionTarget(initial.uid), /another session/);
  setTargetScope(scope);
  const resumed = new ResumeClient(initial.statePath);
  let resumedExit: number | undefined;
  await resumed.subscribe((event) => {
    if (event.kind === "exit") resumedExit = event.exitCode;
  });
  await until(() => resumedExit !== undefined);
  assert.equal(resumedExit, 9);
  resumed.close();
  for (let iteration = 0; iteration < 20; iteration++) {
    const immediate = await launchMonitor(
      "exit 3",
      env,
      `${Date.now()}-immediate-${iteration}`,
      shell,
      directory,
    );
    let status: number | undefined;
    await immediate.client.subscribe((event) => {
      if (event.kind === "exit") status = event.exitCode;
    });
    await until(() => status !== undefined);
    assert.equal(status, 3);
    immediate.client.close();
  }
  const active = await launchMonitor(
    shellCommand("sleep 30", "Start-Sleep -Seconds 30"),
    env,
    `${Date.now()}-reap`,
    shell,
    directory,
  );
  await active.client.whenReady;
  await reapLaunch(active.client.target!);
  assert.equal((await readTarget(active.client.statePath)).exitCode, 137);
  active.client.close();
  const uid = `sh-${Date.now()}-prevented`;
  const statusPath = join(await ensureTargetDirectory(), `${uid}.native.json`);
  const socketPath = ghostmuxSocket(env);
  const binaryPath = await resolveGhostmuxBinary();
  await reapLaunch({ uid, statusPath, socketPath, binaryPath });
  const marker = join(directory, "late-launch");
  await assert.rejects(
    execute(binaryPath, [
      "-S",
      socketPath,
      "new-session",
      "--uid",
      uid,
      "--is-pty",
      "false",
      "--status-path",
      statusPath,
      "--log",
      join(directory, "late.log"),
      "--",
      shell.executable,
      ...shell.commandArgs(`echo leaked > '${marker}'`),
    ]),
  );
  await assert.rejects(access(marker), { code: "ENOENT" });
  if (process.platform !== "win32") {
    const owner = await launchMonitor(
      "sleep 30",
      env,
      `${Date.now()}-owner`,
      shell,
      directory,
    );
    const isolatedEnv = {
      ...env,
      PI_SESSION_ID: `${scope}-isolated`,
      CPI_GHOSTMUX_SOCKET: owner.client.target!.socketPath,
    };
    const isolated = await launchMonitor(
      "sleep 30",
      isolatedEnv,
      `${Date.now()}-isolated`,
      shell,
      directory,
    );
    assert.notEqual(
      isolated.client.target!.socketPath,
      owner.client.target!.socketPath,
    );
    assert.notEqual(
      isolated.client.target!.serverPid,
      owner.client.target!.serverPid,
    );
    await execute(isolated.client.target!.binaryPath, [
      "-S",
      isolated.client.target!.socketPath,
      "kill-server",
    ]);
    assert.equal(
      (await getSessionTarget(owner.client.target!.uid)).completed,
      false,
    );
    await reapLaunch(owner.client.target!);
    owner.client.close();
    isolated.client.close();
    const crashed = await launchMonitor(
      "sleep 30",
      env,
      `${Date.now()}-crash`,
      shell,
      directory,
    );
    await crashed.client.whenReady;
    crashPid = crashed.client.target!.pid;
    let closed = false;
    crashed.client.onClose(() => {
      closed = true;
    });
    await crashed.client.subscribe(() => {});
    process.kill(crashed.client.target!.serverPid, "SIGKILL");
    await until(() => closed);
    assert.equal((await readTarget(crashed.client.statePath)).completed, false);
    assert(crashed.client.target!.error);
    crashed.client.close();
  }
  console.log(
    "Native shell status, immediate exits, scoped identity, reaping, and daemon failure passed without per-command Node processes",
  );
} finally {
  if (crashPid) {
    try {
      process.kill(-crashPid, "SIGKILL");
    } catch {}
  }
  await rm(directory, { recursive: true, force: true });
}
