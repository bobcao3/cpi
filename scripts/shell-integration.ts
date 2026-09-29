import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  runShell,
  setCurrentScope,
  setCompletionHook,
  signalChild,
  silenceChild,
  detachChild,
  getShellBackgrounds,
  killAll,
  resumeBackgroundShells,
  captureSessionScreenshot,
  getSessionTarget,
} from "../extensions/shell/exec.ts";
import {
  getActiveRepeats,
  startRepeat,
  signalRepeat,
} from "../extensions/shell/repeat.ts";
import { readResumeRecords } from "../extensions/shell/monitor.ts";
import { resolveShell } from "../extensions/shell/profile.ts";
import { ghostmuxRpc } from "../extensions/shell/ghostmux.ts";

const execute = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shell = resolveShell("bash");
const tunables = { maxAcc: 8192, previewMaxBytes: 4096, updateMs: 20 };
const truncation = { maxLines: 30 };
async function until(check: () => boolean | Promise<boolean>, seconds = 10) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail("shell lifecycle did not reach the expected state");
}
const directory =
  process.argv[2] ?? (await mkdtemp(join(tmpdir(), "cpi-shell-integration-")));
const scope = `integration-${directory.split("/").at(-1)}`;
const env = {
  ...process.env,
  PI_SESSION_ID: scope,
  PI_SESSION_DIR: directory,
  SCOPED: "preserved",
};
setCurrentScope(scope);
const completions: { id: string; code: number | null; reason: string }[] = [];
setCompletionHook((id, _command, code, reason) => {
  completions.push({ id, code, reason });
});
const run = (command: string, wait = 2, signal?: AbortSignal, pty = false) =>
  runShell(
    command,
    wait,
    env,
    signal,
    undefined,
    "integration",
    30,
    truncation,
    tunables,
    shell,
    directory,
    pty,
  );
if (process.argv[3] === "restart") {
  const result = await run(
    "printf before; sleep 1; printf after; exit 7",
    0.05,
  );
  await until(async () =>
    (await readResumeRecords(directory, scope)).some(
      (record) => record.pid === result.id,
    ),
  );
  await writeFile(join(directory, "restart.json"), JSON.stringify(result));
  process.exit(0);
}
try {
  const bytes = await run(
    "printf '\\xff\\x00\\xfe'; printf '\\n'; pwd; printf '%s' \"$SCOPED\"",
    2,
  );
  assert.equal(bytes.exitCode, 0);
  const raw = await readFile(bytes.fullOutputPath!);
  assert.deepEqual([...raw.subarray(0, 3)], [255, 0, 254]);
  assert(raw.includes(Buffer.from(directory)));
  assert(raw.toString().endsWith("preserved"));
  const exported = await run(
    "command -v ghostmux; printf '%s' \"$CPI_GHOSTMUX_SOCKET\"",
  );
  assert.equal(exported.exitCode, 0);
  assert(exported.text.includes(exported.socketPath!));
  const small = await run("echo small; exit 3");
  assert.equal(small.exitCode, 3);
  await assert.rejects(
    captureSessionScreenshot(small.id!, join(directory, "completed.png")),
    /completed/,
  );
  const background = await run(
    "printf 'one\\n'; sleep .3; printf 'two\\n'",
    0.05,
  );
  assert.equal(background.status, "running");
  assert.equal(background.isPty, false);
  assert(background.cursor!.bytes >= 4);
  await assert.rejects(
    captureSessionScreenshot(background.id!, join(directory, "pipes.png")),
    /pipes/,
  );
  await until(() =>
    completions.some((entry) => entry.id === background.id && entry.code === 0),
  );
  assert.equal(
    await readFile(background.fullOutputPath!, "utf8"),
    "one\ntwo\n",
  );
  const detached = await run("printf start; sleep .4; printf detached", 0.05);
  const log = detachChild(detached.id!);
  assert(log);
  assert(!signalChild(detached.id!, "SIGKILL"));
  killAll();
  await until(async () => (await readFile(log!, "utf8")).endsWith("detached"));
  assert(!completions.some((entry) => entry.id === detached.id));
  const signalled = await run("sleep 20", 0.05);
  assert(signalChild(signalled.id!, "SIGTERM"));
  await until(
    () => !getShellBackgrounds().some((entry) => entry.id === signalled.id),
  );
  const controller = new AbortController();
  const pending = run("printf cancel; sleep 20", 3, controller.signal);
  setTimeout(() => controller.abort(), 200);
  const cancelled = await pending;
  assert.equal(cancelled.status, "completed");
  assert.notEqual(cancelled.exitCode, 0);
  const interactive = await run(
    "printf '\\033[2J\\033[Hready'; read answer; printf '\\nanswer:%s\\n' \"$answer\"",
    0.05,
    undefined,
    true,
  );
  assert.equal(interactive.isPty, true);
  const image = join(directory, "terminal.png");
  assert.equal(
    (await captureSessionScreenshot(interactive.id!, image, 12)).uid,
    interactive.uid,
  );
  assert((await stat(image)).size > 100);
  const target = await getSessionTarget(interactive.uid!);
  const helperDefault = join(directory, "helper-default.png");
  const cliDefault = join(directory, "cli-default.png");
  await captureSessionScreenshot(interactive.id!, helperDefault);
  await ghostmuxRpc(target, ["screenshot", "--output", cliDefault]);
  const helperPng = await readFile(helperDefault);
  const cliPng = await readFile(cliDefault);
  assert.deepEqual(helperPng.subarray(16, 24), cliPng.subarray(16, 24));
  const capture = await ghostmuxRpc(target, [
    "capture-pane",
    "--history",
    "--join",
  ]);
  assert(capture.text.includes("ready"));
  await ghostmuxRpc(target, ["send-input", "--text", "hello\n"]);
  await until(() => completions.some((entry) => entry.id === interactive.id));
  assert(
    (await readFile(interactive.fullOutputPath!, "utf8")).includes(
      "answer:hello",
    ),
  );
  const repeat = startRepeat(
    "n=$(cat count 2>/dev/null || echo 0); n=$((n+1)); echo $n > count; echo iteration-$n; test $n -lt 2",
    0.15,
    env,
    "repeat",
    shell,
    directory,
  );
  await until(() =>
    completions.some((entry) => entry.id === repeat && entry.code === 1),
  );
  assert.equal(await readFile(join(directory, "count"), "utf8"), "2\n");
  const stopped = startRepeat("echo tick", 0.3, env, "stop", shell, directory);
  await pause(150);
  assert(signalRepeat(stopped, "SIGKILL"));
  assert(!getActiveRepeats().some((entry) => entry.id === stopped));
  const breach = startRepeat("sleep 2", 0.15, env, "breach", shell, directory);
  await until(() =>
    completions.some(
      (entry) => entry.id === breach && entry.reason === "breach",
    ),
  );
  await execute(
    process.execPath,
    [fileURLToPath(import.meta.url), directory, "restart"],
    { env },
  );
  await pause(1500);
  const restarted = JSON.parse(
    await readFile(join(directory, "restart.json"), "utf8"),
  );
  await resumeBackgroundShells(directory, scope);
  await until(() =>
    completions.some((entry) => entry.id === restarted.id && entry.code === 7),
  );
  assert.equal(await readFile(restarted.fullOutputPath, "utf8"), "beforeafter");
  assert(
    !(await readResumeRecords(directory, scope)).some(
      (record) => record.pid === restarted.id,
    ),
  );
  await execute(
    process.execPath,
    [fileURLToPath(import.meta.url), directory, "restart"],
    { env },
  );
  const live = JSON.parse(
    await readFile(join(directory, "restart.json"), "utf8"),
  );
  await resumeBackgroundShells(directory, scope);
  assert(getShellBackgrounds().some((entry) => entry.id === live.id));
  assert(signalChild(live.id, "SIGINT"));
  await until(() =>
    completions.some((entry) => entry.id === live.id && entry.code !== 0),
  );
  if (process.platform !== "win32") {
    const failed = await run("sleep 30", 0.05);
    assert(silenceChild(failed.id!));
    process.kill(failed.serverPid!, "SIGKILL");
    try {
      await until(
        () => !getShellBackgrounds().some((entry) => entry.id === failed.id),
      );
      assert(!completions.some((entry) => entry.id === failed.id));
    } finally {
      try {
        process.kill(-Number(failed.id), "SIGKILL");
      } catch {}
    }
  }
  console.log("Shell ghostmux lifecycle integration passed");
} finally {
  killAll();
  await rm(directory, { recursive: true, force: true });
}
