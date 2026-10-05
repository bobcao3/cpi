import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import {
  startRepeat,
  signalRepeat,
  killAllRepeats,
  resumeRepeats,
  setRepeatScopeGetter,
  getRepeatHistory,
  hasActiveRepeats,
} from "../extensions/shell/repeat.ts";
import { resolveShell } from "../extensions/shell/profile.ts";
import { buildShellEnvWithDotenv } from "../extensions/shell/tools.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const [phase, directory] = process.argv.slice(2);
if (!phase) {
  const root = mkdtempSync(join(tmpdir(), "repeat-persistence-"));
  try {
    for (const operation of [
      "start",
      "resume",
      "resume",
      "lifecycle",
      "harness",
      "graceful",
      "resume",
      "resume",
    ]) {
      const child = spawnSync(
        process.execPath,
        [resolve(import.meta.filename), operation, root],
        {
          stdio: "inherit",
          timeout: 30_000,
          env: { ...process.env, CPI_PI_HOST_ENTRY: piExecutableOnPath() },
        },
      );
      assert.equal(child.status, 0, `${operation}: ${child.signal}`);
    }
    console.log(
      "Repeat persistence verified through real SDK JSONL sessions and ghostmux commands.",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  process.exit(0);
}
assert(directory);
const {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} = await hostCodingAgent();
let api!: ExtensionAPI;
let context!: ExtensionContext;
let scope: string | undefined;
setRepeatScopeGetter(() => scope);
async function open(file?: string) {
  const manager = file
    ? SessionManager.open(file)
    : SessionManager.create(directory, directory);
  if (!file)
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "Verify repeat persistence." }],
      timestamp: Date.now(),
    });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    additionalExtensionPaths:
      phase === "harness"
        ? [resolve(import.meta.dir, "../extensions/index.ts")]
        : [],
    extensionFactories: [
      (pi: ExtensionAPI) => {
        api = pi;
        pi.on("session_start", async (_event, ctx) => {
          context = ctx;
          scope = ctx.sessionManager.getSessionId();
          await resumeRepeats(pi, ctx);
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: directory,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory(),
    tools: [],
  });
  await session.bindExtensions({
    onError: (error: { error: string }) => {
      throw new Error(error.error);
    },
  });
  return session;
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((done) => setTimeout(done, 25));
  }
  assert.fail("Repeat command did not reach the expected lifecycle state.");
}
const manifest = join(directory, "manifest.json");
if (phase === "start" || phase === "graceful") {
  const session = await open();
  const env_file = join(directory, "private.env");
  writeFileSync(env_file, "REPEAT_SECRET=never-persist-this-value\n");
  const marker = join(directory, "invocations");
  const command = `printf 'run\\n' >> '${marker}'; printf 'repeat-output\\n'`;
  const id = startRepeat(
    command,
    5,
    buildShellEnvWithDotenv(context.sessionManager, env_file),
    "verification",
    resolveShell("bash"),
    directory,
    env_file,
  );
  const definition = getRepeatHistory(context).find(
    (record) => record.id === id,
  )!;
  assert.equal(definition.status, "running");
  assert.equal(definition.env_file, env_file);
  assert.equal(definition.cwd, directory);
  assert(definition.shell.executable.startsWith("/"));
  await waitFor(() => {
    try {
      return readFileSync(definition.log_path, "utf8").includes("Exit: 0");
    } catch {
      return false;
    }
  });
  assert(
    !readFileSync(session.sessionFile!, "utf8").includes(
      "never-persist-this-value",
    ),
  );
  if (phase === "graceful") killAllRepeats();
  writeFileSync(
    manifest,
    JSON.stringify({
      file: session.sessionFile,
      id,
      marker,
      runs: readFileSync(marker, "utf8"),
      log: definition.log_path,
    }),
  );
  process.exit(0);
}
if (phase === "resume") {
  const saved = JSON.parse(readFileSync(manifest, "utf8"));
  const session = await open(saved.file);
  assert.equal(hasActiveRepeats(), false);
  const record = getRepeatHistory(context).find(
    (value) => value.id === saved.id,
  )!;
  assert.equal(record.status, "interrupted");
  assert(record.acknowledged_at);
  assert.equal(record.log_path, saved.log);
  assert.equal(readFileSync(saved.marker, "utf8"), saved.runs);
  const notifications = context.sessionManager
    .getEntries()
    .filter(
      (entry) =>
        entry.type === "custom_message" &&
        (entry.details as any)?.payload?.id === saved.id,
    );
  assert.equal(notifications.length, 1);
  session.dispose();
  process.exit(0);
}
if (phase === "lifecycle") {
  const first = await open();

  const first_scope = scope;
  const id = startRepeat(
    "true",
    5,
    buildShellEnvWithDotenv(context.sessionManager),
    "live",
    resolveShell("bash"),
    directory,
  );
  await first.reload();
  await resumeRepeats(api, context);
  assert.equal(
    getRepeatHistory(context).find((r) => r.id === id)?.status,
    "running",
  );
  const first_api = api;
  const first_ctx = context;
  const second = await open();
  assert.equal(hasActiveRepeats(), false);
  assert.equal(signalRepeat(id, "SIGTERM"), false);
  scope = first_scope;
  await resumeRepeats(first_api, first_ctx);
  assert.equal(hasActiveRepeats(), true);
  assert.equal(signalRepeat(id, "SIGTERM"), true);
  assert.equal(
    getRepeatHistory(first_ctx).find((r) => r.id === id)?.status,
    "stopped",
  );
  const failed = startRepeat(
    "exit 7",
    5,
    buildShellEnvWithDotenv(first_ctx.sessionManager),
    "failure",
    resolveShell("bash"),
    directory,
  );
  const first_file = first.sessionFile!;
  first.dispose();
  scope = second.sessionId;
  await waitFor(() =>
    readFileSync(first_file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .some(
        (entry) =>
          entry.customType === "cpi-repeat" &&
          entry.data?.id === failed &&
          entry.data?.status === "stopped",
      ),
  );
  const terminal = readFileSync(first_file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .find(
      (entry) =>
        entry.customType === "cpi-repeat" &&
        entry.data?.id === failed &&
        entry.data?.status === "stopped",
    );
  assert.equal(terminal.data.exit_code, 7);
  const breach = startRepeat(
    "sleep 6",
    5,
    buildShellEnvWithDotenv(context.sessionManager),
    "breach",
    resolveShell("bash"),
    directory,
  );
  await waitFor(
    () =>
      getRepeatHistory(context).find((r) => r.id === breach)?.status ===
      "breach",
  );
  first.dispose();
  second.dispose();
  process.exit(0);
}
if (phase === "harness") {
  const session = await open();
  const call = async (name: string, params: Record<string, unknown>) => {
    const ctx = session.extensionRunner.createContext();
    return session.extensionRunner
      .getToolDefinition(name)!
      .execute(crypto.randomUUID(), params, undefined, undefined, ctx);
  };
  try {
    const result = await call("sh_repeat_until", {
      command: "true",
      interval: 5,
      description: "reload integration",
    });
    const id = (result.details as { id: string }).id;
    assert(id);
    const shell = await call("sh", {
      command: "sleep 20",
      description: "reload integration",
      waitfor: 1,
    });
    const shell_id = (shell.details as { id: string }).id;
    await session.reload();
    assert(
      hasActiveRepeats(),
      "The full harness killed the repeat during reload",
    );
    assert.equal(
      getRepeatHistory(context).find((r) => r.id === id)?.status,
      "running",
    );
    const { getActiveBackgrounds } =
      await import("../extensions/shell/exec.ts");
    assert(
      getActiveBackgrounds().some((entry) => entry.id === shell_id),
      "The full harness killed the shell during reload",
    );
    await call("sh_signal", { id, signal: "SIGTERM" });
    await call("sh_signal", { id: shell_id, signal: "SIGKILL" });
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "new",
    });
    session.dispose();
    const { stopSubagentRpc } =
      await import("../extensions/lib/subagent-rpc.ts");
    await stopSubagentRpc();
  }
  process.exit(0);
}
assert.fail(`Unknown verification phase: ${phase}`);
