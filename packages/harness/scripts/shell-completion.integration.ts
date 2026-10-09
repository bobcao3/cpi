import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import {
  SHELL_ENTRY,
  restoreShellActivities,
  type ShellRecord,
} from "../src/shell/persistence.ts";
import { listActivities } from "../src/lib/activity.ts";

const execute = promisify(execFile);
const [directory, phase] = process.argv.slice(2);
const filename = fileURLToPath(import.meta.url);
const directoryName = dirname(filename);
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
const lifecycleRecords = (manager: any): ShellRecord[] =>
  manager
    .getEntries()
    .filter(
      (entry: any) =>
        entry.type === "custom" && entry.customType === SHELL_ENTRY,
    )
    .map((entry: any) => entry.data as ShellRecord);
const latestLifecycleRecord = (manager: any, id: string) =>
  lifecycleRecords(manager).reduce<ShellRecord | undefined>(
    (latest, record) =>
      record.id === id && (!latest || record.updatedAt >= latest.updatedAt)
        ? record
        : latest,
    undefined,
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
      join(directoryName, "shell/completion-delivery.extension.ts"),
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
    for (const step of ["queue", "resume", "ack", "replay", "active-ack"]) {
      await execute(
        process.execPath,
        [...process.execArgv, filename, work, step],
        { env: process.env, timeout: 30000 },
      );
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
  const sessionDir = manager.getSessionDir();
  const scope = manager.getSessionId();
  const record: ShellRecord = metadata?.record ?? {
    version: 1,
    id: randomUUID(),
    scope,
    statePath: join(directory, "shell.state"),
    pid: "completed-target",
    command: "exit 7",
    exitCode: 7,
    logPath: join(directory, "shell.log"),
    startedAt: Date.now() - 10000,
    endedAt: Date.now() - 9000,
    updatedAt: Date.now() - 9000,
    status: "failed",
  };
  if (phase === "queue") {
    manager.appendMessage({
      role: "user",
      content: "Background work",
      timestamp: Date.now(),
    });
    manager.appendCustomEntry(SHELL_ENTRY, record);
    await writeFile(
      metadataPath,
      JSON.stringify({ file: manager.getSessionFile(), record }),
    );
  }
  if (phase === "replay") manager.appendCustomEntry(SHELL_ENTRY, { ...record });
  const activeRecord = { ...record, id: randomUUID(), updatedAt: Date.now() };
  if (phase === "active-ack") {
    manager.appendCustomEntry(SHELL_ENTRY, activeRecord);
    manager.appendCustomMessageEntry(
      "notification",
      "Delivered active shell",
      true,
      {
        kind: "shell-failed",
        summary: "Delivered active shell",
        payload: { "shell-id": record.pid, "exit-code": record.exitCode },
        deliveryId: JSON.stringify([scope, activeRecord.id]),
      },
    );
  }
  const session = await open(manager);
  try {
    if (phase === "active-ack") {
      await session.prompt("/deliver-completions");
      assert.equal(
        notices(manager).length,
        1,
        "A persisted active completion must not become a second away notification",
      );
      assert.equal(
        typeof latestLifecycleRecord(manager, activeRecord.id)?.acknowledgedAt,
        "number",
      );
    } else if (phase === "queue") {
      assert.equal(notices(manager).length, 0);
      assert.equal(
        latestLifecycleRecord(manager, record.id)?.acknowledgedAt,
        undefined,
        "Startup must retain an unacknowledged completion for restart",
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
        typeof latestLifecycleRecord(manager, record.id)?.acknowledgedAt,
        "number",
        "Acknowledgement must be persisted as a lifecycle entry",
      );
    }
    restoreShellActivities(scope);
    assert.equal(
      listActivities(scope).find((entry) => entry.id === record.id)?.ended_at,
      record.endedAt,
      "Acknowledgement must not extend a completed shell's duration",
    );
  } finally {
    session.dispose();
  }
}
