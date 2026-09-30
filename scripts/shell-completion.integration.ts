import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import {
  readCompletedRecords,
  writeCompletedRecord,
} from "../extensions/shell/monitor.ts";

const execute = promisify(execFile);
const [directory, phase] = process.argv.slice(2);
process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
const host = await hostCodingAgent();
const notices = (manager: any) =>
  manager
    .getEntries()
    .filter(
      (entry: any) =>
        entry.type === "custom_message" &&
        entry.details?.kind === "completed-shells",
    );

async function open(manager: any) {
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
      join(import.meta.dir, "shell/completion-delivery.extension.ts"),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await host.createAgentSession({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    noTools: true,
  });
  const errors: unknown[] = [];
  await session.bindExtensions({
    mode: "rpc",
    uiContext: session.extensionRunner.getUIContext(),
    onError: (error: unknown) => errors.push(error),
  });
  assert.deepEqual(errors, []);
  return session;
}

if (!phase) {
  const work = await mkdtemp(join(tmpdir(), "cpi-completion-delivery-"));
  try {
    for (const step of ["queue", "resume", "ack", "replay"]) {
      await execute(process.execPath, [import.meta.filename, work, step], {
        env: process.env,
        timeout: 30000,
      });
    }
    console.log(
      "Completed-shell delivery survived restart, isolated sessions and forks, and suppressed acknowledged replay",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
} else {
  const metadataPath = join(directory, "metadata.json");
  const metadata =
    phase === "queue"
      ? undefined
      : JSON.parse(await readFile(metadataPath, "utf8"));
  const manager = metadata
    ? host.SessionManager.open(metadata.file)
    : host.SessionManager.create(directory, join(directory, "sessions"));
  const record = metadata?.record ?? {
    pid: "completed-target",
    command: "exit 7",
    exitCode: 7,
    logPath: join(directory, "shell.log"),
    completedAt: Date.now(),
  };
  const sessionDir = manager.getSessionDir();
  const scope = manager.getSessionId();
  if (phase === "queue") {
    manager.appendMessage({
      role: "user",
      content: "Background work",
      timestamp: Date.now(),
    });
    await writeCompletedRecord(sessionDir, scope, record.pid, record);
    await writeFile(
      metadataPath,
      JSON.stringify({ file: manager.getSessionFile(), record }),
    );
  }
  if (phase === "replay")
    await writeCompletedRecord(sessionDir, scope, record.pid, record);
  const session = await open(manager);
  try {
    if (phase === "queue") {
      assert.equal(notices(manager).length, 0);
      assert.equal(
        (await readCompletedRecords(sessionDir, scope)).length,
        1,
        "Startup must retain an undelivered completion for restart",
      );
    } else if (phase === "resume") {
      await session.prompt("/queue-completions");
      const other = host.SessionManager.create(directory, sessionDir);
      other.appendMessage({
        role: "user",
        content: "Unrelated session",
        timestamp: Date.now(),
      });
      const unrelated = await open(other);
      try {
        await unrelated.prompt("/deliver-completions");
        assert.equal(
          notices(other).length,
          0,
          "An unrelated session must not consume the owner's queue",
        );
      } finally {
        unrelated.dispose();
      }
      const forkSource = host.SessionManager.open(metadata.file);
      const forkFile = forkSource.createBranchedSession(forkSource.getLeafId());
      const fork = host.SessionManager.open(forkFile);
      const forked = await open(fork);
      try {
        await forked.prompt("/deliver-completions");
        assert.equal(
          notices(fork).length,
          0,
          "A fork must not inherit pending parent completions",
        );
      } finally {
        forked.dispose();
      }
      await session.prompt("/deliver-completions");
      assert.equal(
        notices(manager).length,
        1,
        "Restart must deliver the retained completion exactly once",
      );
      assert.equal(notices(manager)[0].details.payload.shells[0].exitCode, 7);
      const persisted = host.SessionManager.open(metadata.file);
      assert.equal(
        notices(persisted).length,
        1,
        "Delivery must reach the real transcript",
      );
    } else {
      await session.prompt("/deliver-completions");
      assert.equal(
        notices(manager).length,
        1,
        "An acknowledged completion must not be redelivered",
      );
      assert.equal(
        (await readCompletedRecords(sessionDir, scope)).length,
        0,
        "Only the persisted transcript may acknowledge completion records",
      );
    }
  } finally {
    session.dispose();
  }
}
