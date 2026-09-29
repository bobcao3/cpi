import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";

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
      const metadata = JSON.parse(
        await readFile(join(scenario, "metadata.json"), "utf8"),
      );
      for (const record of metadata.shutdown_records ?? []) {
        await writeFile(
          join(metadata.shutdown_directory, record.file),
          record.data,
        );
      }
      await execute(process.execPath, [script, root, scenario, "resume"], {
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
      join(root, "extensions/core.ts"),
      join(root, "extensions/shell.ts"),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const metadata =
    phase === "resume"
      ? JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
      : undefined;
  const manager = metadata
    ? host.SessionManager.open(metadata.session_file)
    : host.SessionManager.create(directory, join(directory, "sessions"));
  if (!metadata)
    manager.appendMessage({
      role: "user",
      content: "Run background work",
      timestamp: Date.now(),
    });
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
    uiContext: session.extensionRunner.getUIContext(),
    onError: (error) => errors.push(error),
  });
  try {
    if (phase === "resume") {
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
      assert.equal(
        new Set(notices.map((message) => message.details.shutdown_record)).size,
        2,
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
      assert.equal(
        (
          await readdir(
            join(
              manager.getSessionDir(),
              "sh-mon",
              manager.getSessionId(),
              "shutdown",
            ),
          )
        ).length,
        0,
      );
    } else {
      const run = (name, command) =>
        session._toolRegistry
          .get("sh")
          .execute(name, { description: name, command, waitfor: 0.05 });
      const detached = await run("detached", "exec sleep 60");
      await session._toolRegistry
        .get("sh_detach")
        .execute("detach", { id: detached.details.id });
      const completed = await session._toolRegistry
        .get("sh")
        .execute("completed", {
          description: "completed",
          command: "printf done",
          waitfor: 2,
        });
      assert.equal(completed.details.status, "completed");
      const active = await run(
        "interrupted shell",
        "printf pending; exec sleep 60",
      );
      const repeated = await session._toolRegistry
        .get("sh_repeat_until")
        .execute("repeat", {
          description: "interrupted monitor",
          command: "exec sleep 60",
          interval: 5,
        });
      const list = () =>
        session._toolRegistry.get("sh_background_ps").execute("list", {});
      await until(async () =>
        (await list()).details?.repeats?.some((entry) => entry.uid),
      );
      const record = {
        session_file: manager.getSessionFile(),
        interrupted: [active.details.id, repeated.details.id],
        socket: active.details.socketPath,
        binary: process.env.GHOSTMUX_BIN,
      };
      if (!record.binary) {
        const { resolveGhostmux } = await import("../bin/ghostmux-resolve.mjs");
        record.binary = await resolveGhostmux();
      }
      await writeFile(join(directory, "metadata.json"), JSON.stringify(record));
      if (phase === "reload") {
        await session.reload();
        assert.equal(notifications(session).length, 2);
        await session.reload();
        assert.equal(notifications(session).length, 2);
      } else {
        await session.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        assert.equal(notifications(session).length, 0);
        const files = await readdir(
          join(
            manager.getSessionDir(),
            "sh-mon",
            manager.getSessionId(),
            "shutdown",
          ),
        );
        assert.equal(files.filter((file) => file.endsWith(".json")).length, 2);
        record.shutdown_directory = join(
          manager.getSessionDir(),
          "sh-mon",
          manager.getSessionId(),
          "shutdown",
        );
        record.shutdown_records = await Promise.all(
          files.map(async (file) => ({
            file,
            data: await readFile(join(record.shutdown_directory, file), "utf8"),
          })),
        );
        await writeFile(
          join(directory, "metadata.json"),
          JSON.stringify(record),
        );
      }
      const listed = await list();
      assert.equal(listed.details, undefined);
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
