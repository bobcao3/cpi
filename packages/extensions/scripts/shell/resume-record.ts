import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostCodingAgent, piExecutableOnPath } from "../../bin/host-pi.mjs";
import { readTarget } from "../../extensions/shell/ghostmux.ts";
import {
  bindShellPersistence,
  writeShellRecord,
} from "../../extensions/shell/persistence.ts";
import type { ShellDialect } from "../../extensions/shell/profile.ts";

export async function writeResumeRecord(
  _directory: string,
  scope: string,
  pid: string,
  statePath: string,
  command: string,
  logPath = "",
  describe?: string,
  dialect?: ShellDialect,
): Promise<void> {
  const target = await readTarget(statePath).catch(() => undefined);
  writeShellRecord({
    version: 1,
    id: randomUUID(),
    scope,
    pid,
    command,
    statePath,
    logPath,
    describe,
    dialect,
    socketPath: target?.socketPath,
    uid: target?.uid,
    serverPid: target?.serverPid,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
  });
}

export async function openShellSession(directory: string, scope: string) {
  process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
  const host = await hostCodingAgent();
  const path = join(directory, "session-path.json");
  let file: string | undefined;
  try {
    file = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const manager = file
    ? host.SessionManager.open(file)
    : host.SessionManager.create(directory, directory, { id: scope });
  if (!file)
    manager.appendMessage({
      role: "user",
      content: "Exercise shell lifecycle",
      timestamp: Date.now(),
    });
  const settingsManager = host.SettingsManager.inMemory();
  const resourceLoader = new host.DefaultResourceLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("session_start", async (_event, ctx) =>
          bindShellPersistence(pi, ctx),
        );
      },
    ],
  });
  await resourceLoader.reload();
  const { session } = await host.createAgentSession({
    cwd: directory,
    agentDir: directory,
    sessionManager: manager,
    settingsManager,
    resourceLoader,
    noTools: true,
  });
  await session.bindExtensions({
    onError: (error) => {
      throw error;
    },
  });
  await writeFile(path, JSON.stringify(manager.getSessionFile()));
  return session;
}
