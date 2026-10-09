import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import { shellCommand } from "./shell-platform.mjs";
import { resolveGhostmux } from "@cpi/ghostmux/resolve";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = process.argv[2] ?? dirname(dirname(script));
const directory = process.argv[3];
const phase = process.argv[4];
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail("Shell shutdown did not reach the expected state");
}
const notifications = (session) =>
  session.sessionManager
    .getBranch()
    .filter(
      (message) =>
        message.type === "custom_message" &&
        message.details?.kind === "interrupted-shells",
    );
const shellRecords = (manager) =>
  manager
    .getEntries()
    .filter((entry) => entry.customType === "cpi-shell")
    .map((entry) => entry.data)
    .filter(Boolean);
const latestShellRecords = (manager) => {
  const latest = new Map();
  for (const record of shellRecords(manager)) {
    const previous = latest.get(record.id);
    if (!previous || record.updatedAt >= previous.updatedAt)
      latest.set(record.id, record);
  }
  return [...latest.values()];
};

if (!phase) {
  const work = await mkdtemp(join(tmpdir(), "cpi-shell-shutdown-"));
  try {
    for (const reason of ["quit", "reload"]) {
      const scenario = join(work, reason);
      const env = {
        ...process.env,
        CPI_PI_HOST_ENTRY:
          process.env.CPI_PI_HOST_ENTRY ?? piExecutableOnPath(),
        PI_SUBAGENT: "1",
      };
      await execute(process.execPath, [script, root, scenario, reason], {
        env,
        timeout: 30000,
      });
      await execute(process.execPath, [script, root, scenario, "resume"], {
        env,
        timeout: 30000,
      });
      await execute(process.execPath, [script, root, scenario, "replay"], {
        env,
        timeout: 30000,
      });
    }
    console.log(
      "Real Pi shutdown/reload preserved interruption notices across process restarts",
    );
  } finally {
    for (const reason of ["quit", "reload"]) {
      try {
        const metadata = JSON.parse(
          await readFile(join(work, reason, "metadata.json"), "utf8"),
        );
        await execute(metadata.binary, ["-S", metadata.socket, "kill-server"], {
          timeout: 5000,
        });
      } catch {}
    }
    await rm(work, { recursive: true, force: true });
  }
} else {
  process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
  process.env.PI_SUBAGENT = "1";
  const host = await hostCodingAgent();
  const settings = host.SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new host.DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      join(root, "src/core.ts"),
      join(root, "src/shell.ts"),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const restoring = phase === "resume" || phase === "replay";
  const metadata = restoring
    ? JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
    : undefined;
  const manager = metadata
    ? host.SessionManager.open(
        metadata.session_file,
        join(directory, "sessions"),
      )
    : host.SessionManager.create(directory, join(directory, "sessions"));
  if (!metadata)
    manager.appendMessage({
      role: "user",
      content: "Run background work",
      timestamp: Date.now(),
    });
  if (phase === "replay") {
    for (const record of metadata.shutdown_records)
      manager.appendCustomEntry("cpi-shell", { ...record });
  }
  const { session } = await host.createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: true,
  });
  const errors = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: { ...session.extensionRunner.getUIContext() },
    onError: (error) => errors.push(error),
  });
  assert.equal(session.extensionRunner.hasUI(), true);
  assert.deepEqual(errors, [], "Extension lifecycle initialization failed");
  try {
    if (restoring) {
      const notices = notifications(session);
      assert.equal(notices.length, 2);
      assert.deepEqual(
        new Set(notices.map((message) => message.details.payload.id)),
        new Set(metadata.interrupted),
      );
      const notificationUsers = host
        .convertToLlm(session.messages)
        .filter((message) => {
          if (message.role !== "user") return false;
          const text =
            typeof message.content === "string"
              ? message.content
              : message.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("");
          return text.includes('<notification type="interrupted-shells">');
        });
      assert.equal(notificationUsers.length, 2);
      const shellNotices = notices.filter(
        (message) => message.details.payload.kind === "shell",
      );
      assert.equal(shellNotices.length, 1);
      assert.equal(
        shellNotices[0].details.shutdown_record,
        metadata.shutdown_records[0].id,
      );
      assert.equal(
        shellNotices[0].details.payload.activityId,
        metadata.shutdown_records[0].id,
      );
      assert(
        notices.every(
          (message) =>
            message.content.includes(message.details.payload.command) &&
            message.content.includes(message.details.payload.log_path),
        ),
      );
      assert(
        notices.every((message) => !message.content.includes("<exitCode>")),
      );
      assert.equal(session.isStreaming, false);
      const entries = (await readFile(manager.getSessionFile(), "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        entries.filter(
          (entry) =>
            entry.type === "custom_message" &&
            entry.details?.kind === "interrupted-shells",
        ).length,
        2,
      );
      for (const record of metadata.shutdown_records) {
        const latest = latestShellRecords(manager).find(
          (candidate) => candidate.id === record.id,
        );
        assert.equal(latest?.status, "shutdown");
        assert.equal(typeof latest?.acknowledgedAt, "number");
      }
    } else {
      const run = (name, command) =>
        session._toolRegistry
          .get("sh")
          .execute(name, { description: name, command, waitfor: 0.05 });
      const detached = await run(
        "detached",
        shellCommand("exec sleep 60", "Start-Sleep -Seconds 60"),
      );
      await session._toolRegistry
        .get("sh_detach")
        .execute("detach", { id: detached.details.id });
      const detachedRecord = latestShellRecords(manager).find(
        (record) => record.pid === detached.details.id,
      );
      assert.notEqual(detachedRecord?.id, detached.details.id);
      assert.equal(detachedRecord?.status, "detached");
      assert.equal(typeof detachedRecord?.acknowledgedAt, "number");
      const completed = await session._toolRegistry
        .get("sh")
        .execute("completed", {
          description: "completed",
          command: shellCommand("printf done", "Write-Output done"),
          waitfor: 2,
        });
      assert.equal(completed.details.status, "completed");
      const completedRecord = latestShellRecords(manager).find(
        (record) => record.pid === completed.details.id,
      );
      assert.notEqual(completedRecord?.id, completed.details.id);
      assert.equal(completedRecord?.status, "completed");
      assert.equal(typeof completedRecord?.acknowledgedAt, "number");
      const active = await run(
        "interrupted shell",
        shellCommand(
          "printf pending; exec sleep 60",
          "Write-Output pending; Start-Sleep -Seconds 60",
        ),
      );
      const activeRecord = latestShellRecords(manager).find(
        (record) => record.pid === active.details.id,
      );
      assert.notEqual(activeRecord?.id, active.details.id);
      assert.equal(activeRecord?.status, "running");
      const repeated = await session._toolRegistry
        .get("sh_repeat_until")
        .execute("repeat", {
          description: "interrupted monitor",
          command: shellCommand("exec sleep 60", "Start-Sleep -Seconds 60"),
          interval: 5,
        });
      const list = () =>
        session._toolRegistry.get("sh_background_ps").execute("list", {});
      await until(async () =>
        (await list()).details?.repeats?.some((entry) => entry.uid),
      );
      if (phase === "quit")
        await until(() =>
          manager
            .getEntries()
            .some(
              (entry) =>
                entry.customType === "cpi-repeat" &&
                entry.data?.id === repeated.details.id &&
                entry.data?.status === "running",
            ),
        );
      const record = {
        session_file: manager.getSessionFile(),
        socket: active.details.socketPath,
        binary: process.env.GHOSTMUX_BIN,
      };
      if (!record.binary) {
        record.binary = await resolveGhostmux();
      }
      if (phase === "reload") {
        await session.reload();
        assert.equal(notifications(session).length, 0);
        await session.reload();
        assert.equal(notifications(session).length, 0);
      } else {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        assert.equal(notifications(session).length, 0);
      }
      const listed = await list();
      if (phase === "reload") {
        assert(
          listed.details.backgrounds.some(
            (entry) => entry.id === active.details.id,
          ),
        );
        assert(
          listed.details.repeats.some(
            (entry) => entry.id === repeated.details.id,
          ),
        );
      } else assert.equal(listed.details, undefined);
      const { stdout } = await execute(record.binary, [
        "-S",
        record.socket,
        "list-sessions",
        "--json",
      ]);
      const native = JSON.parse(stdout);
      assert(
        native.sessions.some((entry) => entry.uid === detached.details.uid),
      );
      if (phase === "reload") {
        assert(
          native.sessions.some((entry) => entry.uid === active.details.uid),
        );
      } else {
        await until(async () => {
          const { stdout } = await execute(record.binary, [
            "-S",
            record.socket,
            "list-sessions",
            "--json",
          ]);
          return !JSON.parse(stdout).sessions.some(
            (entry) => entry.uid === active.details.uid,
          );
        });
      }
      if (phase === "reload") {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        assert.equal(notifications(session).length, 0);
      }
      const shutdownRecords = latestShellRecords(manager).filter(
        (entry) =>
          entry.pid === active.details.id &&
          entry.status === "shutdown" &&
          entry.acknowledgedAt === undefined,
      );
      assert.equal(shutdownRecords.length, 1);
      assert.equal(shutdownRecords[0].scope, manager.getSessionId());
      record.shutdown_records = shutdownRecords;
      record.interrupted = [active.details.id, repeated.details.id];
      await writeFile(join(directory, "metadata.json"), JSON.stringify(record));
    }
    assert.deepEqual(errors, []);
  } finally {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
}
process.exit(0);
