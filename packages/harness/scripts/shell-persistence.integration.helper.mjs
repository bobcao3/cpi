import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { nodeProgram } from "./shell-platform.mjs";

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
export async function until(check, message, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await check()) return;
    await pause(25);
  }
  assert.fail(message);
}
export const records = (manager) =>
  manager
    .getEntries()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === "cpi-shell",
    )
    .map((entry) => entry.data);
export const latest = (manager, id) =>
  records(manager)
    .reverse()
    .find((record) => record.id === id);
export const sessionRecords = (manager) => {
  const result = new Map();
  for (const record of records(manager)) result.set(record.id, record);
  return [...result.values()];
};

export function createHarness(host, root, directory) {
  const invoke = (session, name, parameters) => {
    const value = session._toolRegistry.get(name);
    assert(value, `Missing ${name}`);
    return value.execute(randomUUID(), parameters, undefined, undefined);
  };
  const list = (session) => invoke(session, "sh_background_ps", {});
  const runtimeFor = async (manager, extensionPaths = []) => {
    const createRuntime = async ({
      cwd,
      agentDir,
      sessionManager,
      sessionStartEvent,
    }) => {
      const settingsManager = host.SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const services = await host.createAgentSessionServices({
        cwd,
        agentDir,
        settingsManager,
        resourceLoaderOptions: {
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          additionalExtensionPaths: [
            join(root, "src/shell.ts"),
            ...extensionPaths,
          ],
        },
      });
      assert.deepEqual(services.resourceLoader.getExtensions().errors, []);
      const created = await host.createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        noTools: "builtin",
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };
    const runtime = await host.createAgentSessionRuntime(createRuntime, {
      cwd: manager.getCwd(),
      agentDir: directory,
      sessionManager: manager,
    });
    const bind = (session) =>
      session.bindExtensions({
        mode: "rpc",
        uiContext: { ...session.extensionRunner.getUIContext() },
        onError: (error) => {
          throw error;
        },
      });
    runtime.setRebindSession(bind);
    await bind(runtime.session);
    return runtime;
  };
  const launch = async (session, name, delay, marker, waitfor = 0.05) => {
    const command = await nodeProgram(
      directory,
      name,
      `import {writeFileSync} from "node:fs"; process.stdout.write(${JSON.stringify(`${name}\n`)}); setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(name)}); }, ${delay});`,
    );
    const result = await invoke(session, "sh", {
      description: name,
      command,
      waitfor,
    });
    const record = records(session.sessionManager)
      .filter((item) => item.pid === result.details.id)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    assert(record, `Missing shell record for ${result.details.id}`);
    return {
      ...result,
      details: {
        ...result.details,
        activityId: record.id,
        statePath: record.statePath,
        logPath: record.logPath,
      },
    };
  };
  const waitCompleted = async (manager, id) => {
    await until(() => {
      const record = latest(
        host.SessionManager.open(manager.getSessionFile()),
        id,
      );
      return record !== undefined && record.status !== "running";
    }, `Shell ${id} did not complete`);
    return latest(host.SessionManager.open(manager.getSessionFile()), id);
  };
  const markerExists = (path) =>
    access(path).then(
      () => true,
      () => false,
    );
  return { invoke, launch, list, markerExists, runtimeFor, waitCompleted };
}

export async function runRuntimePhase(host, root, directory) {
  const H = createHarness(host, root, directory);
  const sessions = join(directory, "sessions");
  const owner = host.SessionManager.create(directory, sessions);
  const rootEntry = owner.appendMessage({
    role: "user",
    content: "owner root",
    timestamp: Date.now(),
  });
  const foreign = host.SessionManager.create(directory, sessions);
  foreign.appendMessage({
    role: "user",
    content: "foreign",
    timestamp: Date.now(),
  });
  const runtime = await H.runtimeFor(owner);
  try {
    const foreground = await H.launch(
      runtime.session,
      "foreground",
      10,
      join(directory, "foreground.marker"),
      2,
    );
    assert.equal(foreground.details.status, "completed");
    const foregroundRecord = latest(owner, foreground.details.activityId);
    assert.match(foregroundRecord.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.equal(foregroundRecord.status, "completed");
    assert.equal(foregroundRecord.scope, owner.getSessionId());
    assert.equal(
      new Set([
        foregroundRecord.logPath,
        foregroundRecord.statePath,
        foregroundRecord.socketPath,
      ]).size,
      3,
    );

    const reloadMarker = join(directory, "reload.marker");
    const reloading = await H.launch(
      runtime.session,
      "reload-worker",
      900,
      reloadMarker,
    );
    await runtime.session.reload();
    assert(
      (await H.list(runtime.session)).details.backgrounds.some(
        (entry) => entry.id === reloading.details.id,
      ),
    );
    assert.equal(
      latest(owner, reloading.details.activityId).id,
      reloading.details.activityId,
    );
    owner.branch(rootEntry);
    assert(
      (await H.list(runtime.session)).details.backgrounds.some(
        (entry) => entry.id === reloading.details.id,
      ),
    );
    await until(() => H.markerExists(reloadMarker), "Reload worker stopped");

    const awayMarker = join(directory, "switch-away.marker");
    const away = await H.launch(
      runtime.session,
      "switch-away",
      700,
      awayMarker,
    );
    const ownerFile = owner.getSessionFile();
    await runtime.switchSession(foreign.getSessionFile());
    assert.equal((await H.list(runtime.session)).details, undefined);
    assert.equal(
      (
        await H.invoke(runtime.session, "sh_signal", {
          id: away.details.id,
          signal: "SIGKILL",
        })
      ).isError,
      true,
    );
    await until(() => H.markerExists(awayMarker), "Off-screen shell stopped");
    await H.waitCompleted(owner, away.details.activityId);
    assert.equal(records(runtime.session.sessionManager).length, 0);
    assert.equal(
      latest(host.SessionManager.open(ownerFile), away.details.activityId)
        .status,
      "completed",
    );

    await runtime.switchSession(ownerFile);
    const newMarker = join(directory, "new-away.marker");
    const newAway = await H.launch(runtime.session, "new-away", 650, newMarker);
    const beforeNew = runtime.session.sessionFile;
    await runtime.newSession();
    assert.equal((await H.list(runtime.session)).details, undefined);
    await until(() => H.markerExists(newMarker), "New-session shell stopped");
    assert.equal(
      (
        await H.waitCompleted(
          host.SessionManager.open(beforeNew),
          newAway.details.activityId,
        )
      ).status,
      "completed",
    );

    await runtime.switchSession(ownerFile);
    runtime.session.sessionManager.appendMessage({
      role: "user",
      content: "fork point",
      timestamp: Date.now(),
    });
    const forkMarker = join(directory, "fork-away.marker");
    const forkAway = await H.launch(
      runtime.session,
      "fork-away",
      650,
      forkMarker,
    );
    await runtime.fork(runtime.session.sessionManager.getLeafId(), {
      position: "at",
    });
    assert(
      records(runtime.session.sessionManager).some(
        (record) => record.id === forkAway.details.activityId,
      ),
    );
    assert.equal((await H.list(runtime.session)).details, undefined);
    assert.equal(
      (
        await H.invoke(runtime.session, "sh_signal", {
          id: forkAway.details.id,
          signal: "SIGKILL",
        })
      ).isError,
      true,
    );
    await until(() => H.markerExists(forkMarker), "Forked-away shell stopped");
    assert.equal(
      (
        await H.waitCompleted(
          host.SessionManager.open(ownerFile),
          forkAway.details.activityId,
        )
      ).status,
      "completed",
    );
  } finally {
    await runtime.dispose();
  }
}
