import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { hostCodingAgent, piExecutableOnPath } from "../bin/host-pi.mjs";
import {
  createHarness,
  latest,
  runRuntimePhase,
  sessionRecords,
  until,
} from "./shell-persistence.integration.helper.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const root = dirname(dirname(script));
const [directory, phase] = process.argv.slice(2);
const metadataPath = directory && join(directory, "metadata.json");
process.env.CPI_PI_HOST_ENTRY ??= piExecutableOnPath();
process.env.PI_SUBAGENT = "1";
const host = await hostCodingAgent();
const H = directory && createHarness(host, root, directory);

if (!phase) {
  const work = await mkdtemp(join(tmpdir(), "cpi-shell-persistence-"));
  const env = {
    ...process.env,
    CPI_PI_HOST_ENTRY: process.env.CPI_PI_HOST_ENTRY,
  };
  try {
    for (const step of [
      "runtime",
      "callback-failure",
      "crash",
      "recover",
      "legacy-start",
      "legacy-recover",
    ])
      await execute(
        process.execPath,
        [...process.execArgv, script, work, step],
        {
          env,
          timeout: 60000,
        },
      );
    console.log(
      "Shell persistence passed lifecycle, reload, restart, session replacement, branch, detach, and legacy migration integration",
    );
  } finally {
    try {
      const metadata = JSON.parse(
        await readFile(join(work, "metadata.json"), "utf8"),
      );
      for (const target of metadata.targets ?? [])
        await execute(
          target.binaryPath,
          ["-S", target.socketPath, "kill-server"],
          {
            timeout: 5000,
          },
        ).catch(() => {});
    } catch {}
    await rm(work, { recursive: true, force: true });
  }
} else if (phase === "runtime") {
  await runRuntimePhase(host, root, directory);
} else if (phase === "callback-failure") {
  const manager = host.SessionManager.create(
    directory,
    join(directory, "callback-sessions"),
  );
  manager.appendMessage({
    role: "user",
    content: "callback failure",
    timestamp: Date.now(),
  });
  const runtime = await H.runtimeFor(manager, [
    join(root, "scripts/shell/callback-failure.extension.ts"),
  ]);
  let launched;
  try {
    await runtime.session.reload();
    await runtime.session.prompt("/arm-stale-callback");
    launched = await H.launch(
      runtime.session,
      "failed-callback",
      300,
      join(directory, "failed-callback.marker"),
    );
    const final = await H.waitCompleted(manager, launched.details.activityId);
    await runtime.session.prompt("/report-stale-callback");
    assert.equal(final.status, "completed");
    assert.equal(final.acknowledgedAt, undefined);
    const callbackFailure = manager
      .getEntries()
      .find((entry) => entry.customType === "cpi-callback-failure");
    assert.match(callbackFailure?.data ?? "", /stale/);
    assert.equal((await H.list(runtime.session)).details, undefined);
    assert.equal(
      manager.getEntries().filter((entry) => entry.type === "custom_message")
        .length,
      0,
    );
  } finally {
    await runtime.dispose();
    if (launched)
      await execute(
        launched.details.binaryPath,
        ["-S", launched.details.socketPath, "kill-server"],
        { timeout: 5000 },
      ).catch(() => {});
  }
} else if (phase === "crash") {
  const manager = host.SessionManager.create(
    directory,
    join(directory, "restart-sessions"),
  );
  manager.appendMessage({
    role: "user",
    content: "restart",
    timestamp: Date.now(),
  });
  const runtime = await H.runtimeFor(manager, [
    join(root, "scripts/shell/callback-failure.extension.ts"),
  ]);
  const long = await H.launch(
    runtime.session,
    "restart-long",
    15000,
    join(directory, "long.marker"),
  );
  const away = await H.launch(
    runtime.session,
    "restart-away",
    2000,
    join(directory, "away.marker"),
  );
  const detached = await H.launch(
    runtime.session,
    "restart-detached",
    1300,
    join(directory, "detached.marker"),
  );
  const detachedResult = await H.invoke(runtime.session, "sh_detach", {
    id: detached.details.id,
  });
  assert.equal(detachedResult.details.detached, true);
  const silent = await H.launch(
    runtime.session,
    "restart-silent",
    2000,
    join(directory, "silent.marker"),
  );
  await runtime.session.prompt(`/silence-completion ${silent.details.id}`);
  await writeFile(
    metadataPath,
    JSON.stringify({
      restart: {
        file: manager.getSessionFile(),
        long: { id: long.details.activityId, pid: long.details.id },
        away: { id: away.details.activityId, pid: away.details.id },
        detached: { id: detached.details.activityId, pid: detached.details.id },
        silent: { id: silent.details.activityId, pid: silent.details.id },
      },
      targets: [long.details, away.details, detached.details, silent.details],
    }),
  );
  process.exit(0);
} else if (phase === "recover") {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await until(
    () =>
      access(join(directory, "away.marker")).then(
        () => true,
        () => false,
      ),
    "Away shell did not finish",
  );
  await until(
    () =>
      access(join(directory, "silent.marker")).then(
        () => true,
        () => false,
      ),
    "Silent shell did not finish",
  );
  const manager = host.SessionManager.open(metadata.restart.file);
  const idsBefore = new Map(
    sessionRecords(manager).map((record) => [record.pid, record.id]),
  );
  const longTarget = metadata.targets.find(
    (target) => target.activityId === metadata.restart.long.id,
  );
  const longState = await readFile(longTarget.statePath);
  await writeFile(longTarget.statePath, "{");
  const runtime = await H.runtimeFor(manager);
  try {
    assert.equal(latest(manager, metadata.restart.long.id).status, "running");
    assert.equal((await H.list(runtime.session)).details, undefined);
    await writeFile(longTarget.statePath, longState);
    await runtime.session.reload();
    const active = await H.list(runtime.session);
    assert(
      active.details.backgrounds.some(
        (entry) => entry.id === metadata.restart.long.pid,
      ),
    );
    const { listActivities } = await import(
      pathToFileURL(join(root, "extensions/lib/activity.ts"))
    );
    assert(
      Number(
        listActivities(manager.getSessionId()).find(
          (entry) => entry.id === metadata.restart.long.id,
        )?.metrics?.output_bytes,
      ) > 0,
    );
    assert(
      !active.details.backgrounds.some(
        (entry) => entry.id === metadata.restart.detached.pid,
      ),
    );
    for (const item of [
      metadata.restart.long,
      metadata.restart.away,
      metadata.restart.detached,
      metadata.restart.silent,
    ])
      assert.equal(latest(manager, item.id).id, idsBefore.get(item.pid));
    assert.equal(latest(manager, metadata.restart.away.id).status, "completed");
    assert.equal(
      latest(manager, metadata.restart.detached.id).status,
      "detached",
    );
    const silent = latest(manager, metadata.restart.silent.id);
    assert.equal(silent.status, "completed");
    assert.equal(typeof silent.acknowledgedAt, "number");
    const stopped = await H.invoke(runtime.session, "sh_signal", {
      id: metadata.restart.long.pid,
      signal: "SIGKILL",
    });
    assert.notEqual(stopped.isError, true);
    const final = await H.waitCompleted(manager, metadata.restart.long.id);
    assert.equal(final.status, "cancelled");
    await until(
      () =>
        access(join(directory, "detached.marker")).then(
          () => true,
          () => false,
        ),
      "Detached worker did not survive",
    );
  } finally {
    await runtime.dispose();
  }
} else if (phase === "legacy-start") {
  const manager = host.SessionManager.create(
    directory,
    join(directory, "legacy-sessions"),
  );
  manager.appendMessage({
    role: "user",
    content: "legacy",
    timestamp: Date.now(),
  });
  const runtime = await H.runtimeFor(manager);
  const live = await H.launch(
    runtime.session,
    "legacy-live",
    15000,
    join(directory, "legacy-live.marker"),
  );
  const done = await H.launch(
    runtime.session,
    "legacy-done",
    500,
    join(directory, "legacy-done.marker"),
  );
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  metadata.legacy = {
    file: manager.getSessionFile(),
    scope: manager.getSessionId(),
    live,
    done,
  };
  metadata.targets.push(live.details, done.details);
  await writeFile(metadataPath, JSON.stringify(metadata));
  process.exit(0);
} else {
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await until(
    () =>
      access(join(directory, "legacy-done.marker")).then(
        () => true,
        () => false,
      ),
    "Legacy completed shell did not finish",
  );
  const { file, scope, live, done } = metadata.legacy;
  const lines = (await readFile(file, "utf8")).trim().split("\n");
  await writeFile(
    file,
    lines
      .filter((line) => JSON.parse(line).customType !== "cpi-shell")
      .join("\n") + "\n",
  );
  const manager = host.SessionManager.open(file);
  const legacyDirectory = join(manager.getSessionDir(), "sh-mon", scope);
  await mkdir(join(legacyDirectory, "done"), { recursive: true });
  const livePath = join(legacyDirectory, `${live.details.id}.json`);
  const donePath = join(legacyDirectory, "done", `${done.details.id}.json`);
  const doneResumePath = join(legacyDirectory, `${done.details.id}.json`);
  await writeFile(
    livePath,
    JSON.stringify({
      pid: live.details.id,
      sockPath: live.details.statePath,
      cmd: "legacy-live",
      logPath: live.details.fullOutputPath,
    }),
  );
  await writeFile(
    donePath,
    JSON.stringify({
      pid: done.details.id,
      command: "legacy-done",
      exitCode: 0,
      logPath: done.details.fullOutputPath,
      completedAt: Date.now() - 1000,
    }),
  );
  await writeFile(
    doneResumePath,
    JSON.stringify({
      pid: done.details.id,
      sockPath: done.details.statePath,
      cmd: "legacy-done",
      logPath: done.details.fullOutputPath,
    }),
  );
  const runtime = await H.runtimeFor(manager);
  try {
    const migrated = sessionRecords(manager);
    const liveRecord = migrated.find(
      (record) => record.legacyPath === livePath,
    );
    const doneRecord = migrated.find(
      (record) => record.pid === done.details.id,
    );
    assert.match(liveRecord.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.match(doneRecord.id, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
    assert.equal(doneRecord.status, "completed");
    assert.equal(
      migrated.filter((record) => record.pid === done.details.id).length,
      1,
    );
    assert(doneRecord.startedAt <= doneRecord.updatedAt);
    await assert.rejects(access(livePath), { code: "ENOENT" });
    await assert.rejects(access(donePath), { code: "ENOENT" });
    await assert.rejects(access(doneResumePath), { code: "ENOENT" });
    assert(
      (await H.list(runtime.session)).details.backgrounds.some(
        (entry) => entry.id === live.details.id,
      ),
    );
    await runtime.session.reload();
    assert.equal(latest(manager, liveRecord.id).id, liveRecord.id);
    assert(
      (await H.list(runtime.session)).details.backgrounds.some(
        (entry) => entry.id === live.details.id,
      ),
    );
    await H.invoke(runtime.session, "sh_signal", {
      id: live.details.id,
      signal: "SIGKILL",
    });
    assert.equal(
      (await H.waitCompleted(manager, liveRecord.id)).id,
      liveRecord.id,
    );
  } finally {
    await runtime.dispose();
  }
}
