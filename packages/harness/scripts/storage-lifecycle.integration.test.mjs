import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { runForkProbe } from "../src/lib/fork-probe.ts";
import {
  captureSessionOwner,
  sessionArtifactPath,
} from "../src/lib/storage/owner.ts";
import { pending_storage_operations } from "../src/lib/storage/operations.ts";
import { read_guardian_record } from "../src/lib/storage/journal.ts";
import { runSubagentWorker, stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { state } from "../src/lib/subagent-rpc-runtime.ts";
import { with_session_scratch } from "../src/lib/storage/scratch.ts";
import { localFixture } from "./local-fixture.mjs";
import { until } from "./shell-persistence.integration.helper.mjs";
import { packagePath } from "./test-runtime.mjs";

function gate() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function only_record(owner) {
  const directory = sessionArtifactPath(owner, "storage-guardian");
  const files = (await readdir(directory)).filter((name) =>
    name.endsWith(".json"),
  );
  assert.equal(files.length, 1);
  const path = join(directory, files[0]);
  return { path, value: await read_guardian_record(path) };
}

const supported = { skip: process.platform !== "linux", timeout: 60000 };
test(
  "real session reload and switch preserve probe ownership; pending cleanup blocks deletion and quit",
  supported,
  async () => {
    const host = await hostCodingAgent();
    const entered = gate();
    const release = gate();
    let blocked_root;
    let probe_requests = 0;
    const local = await localFixture(async () => {
      if (++probe_requests > 1) return { content: "ADMITTED_CHILD" };
      entered.resolve();
      await release.promise;
      await chmod(blocked_root, 0o500);
      return { content: "OWNED_PROBE" };
    });
    let runtime;
    let probe;
    try {
      const manager = host.SessionManager.create(
        local.directory,
        join(local.directory, "sessions"),
      );
      manager.appendModelChange("local-fixture", "fixture");
      manager.appendMessage({
        role: "user",
        content: "Keep this probe owned by its original session.",
        timestamp: Date.now(),
      });
      const parent_file = manager.getSessionFile();
      const owner = captureSessionOwner(manager);
      const create = async ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) => {
        const services = await host.createAgentSessionServices({
          cwd,
          agentDir,
          resourceLoaderOptions: {
            noExtensions: true,
            additionalExtensionPaths: [packagePath("src/core.ts")],
          },
        });
        const created = await host.createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
        });
        return { ...created, services, diagnostics: services.diagnostics };
      };
      runtime = await host.createAgentSessionRuntime(create, {
        cwd: local.directory,
        agentDir: local.agentDir,
        sessionManager: manager,
      });
      const bind = (session) =>
        session.bindExtensions({
          mode: "rpc",
          uiContext: { ...session.extensionRunner.getUIContext() },
        });
      runtime.setRebindSession(bind);
      await bind(runtime.session);
      blocked_root = sessionArtifactPath(owner, "fork-probes");
      probe = runForkProbe(
        {
          parentSessionFile: parent_file,
          cwd: local.directory,
          timeoutMs: 20000,
        },
        "Describe your status.",
      );
      await Promise.race([
        entered.promise,
        probe.then((result) => {
          throw new Error(
            `probe finished before request: ${JSON.stringify(result)}`,
          );
        }),
      ]);
      const registration = await only_record(owner);
      assert.equal(registration.value.host_pid, process.pid);
      assert.equal(registration.value.session_id, owner.session_id);
      assert.equal(existsSync(registration.value.path), true);
      let switched_id;
      await with_session_scratch(
        owner,
        "fork-probes",
        async (directory, signal) => {
          await runtime.newSession();
          switched_id = runtime.session.sessionManager.getSessionId();
          const child = await runSubagentWorker(
            {
              version: 1,
              kind: "fork-probe",
              runId: "admitted-before-switch",
              parentSessionFile: parent_file,
              parentSessionId: owner.session_id,
              sessionDir: directory,
              prompt: "Finish the already-admitted operation.",
              toolsDisabledMessage: "Tools are disabled.",
              maxOutputTokens: 1024,
              cwd: local.directory,
              env: Object.fromEntries(
                Object.entries(process.env).filter(
                  ([, value]) => typeof value === "string",
                ),
              ),
            },
            { owner, signal },
          );
          assert.equal(child.exitCode, 0, child.error?.message);
          assert.equal(child.observation.finalAnswer, "ADMITTED_CHILD");
        },
      );
      assert.equal(
        state().owner.session_id,
        switched_id,
        "admitted old-owner work must not rebind the current session's RPC listener",
      );
      await runtime.session.reload();
      assert.equal(pending_storage_operations(owner).length, 2);
      await runtime.newSession();
      assert.notEqual(
        runtime.session.sessionManager.getSessionId(),
        owner.session_id,
      );
      assert.equal(existsSync(registration.value.path), true);
      release.resolve();
      const result = await probe;
      assert.equal(result.answer, "OWNED_PROBE");
      assert.equal(result.ok, false);
      assert.match(result.errorMessage, /cleanup pending/);
      assert.equal(pending_storage_operations(owner).length, 1);
      const original_session = await readFile(parent_file);
      const deletion = await host.deleteSessionFile(parent_file, {
        timeoutMs: 2000,
      });
      assert.equal(deletion.ok, false);
      assert.match(deletion.error, /[Pp]ending/);
      assert.deepEqual(await readFile(parent_file), original_session);
      const active = runtime.session;
      await assert.rejects(active.close({ timeoutMs: 2000 }), /[Pp]ending/);
      assert.equal(
        active.extensionRunner.createContext().sessionManager.getSessionId(),
        active.sessionManager.getSessionId(),
      );
      const refused = await runForkProbe(
        { parentSessionFile: parent_file, cwd: local.directory },
        "No new allocation while closing.",
      );
      assert.equal(refused.ok, false);
      assert.match(refused.errorMessage, /closing/);
      assert.equal(local.requests.length, 2);
      await chmod(blocked_root, 0o700);
      const retried = await host.deleteSessionFile(parent_file, {
        timeoutMs: 5000,
      });
      assert.equal(retried.ok, true, retried.error);
      assert.equal(existsSync(parent_file), false);
      assert.equal(existsSync(registration.value.path), false);
      assert.equal(
        (await read_guardian_record(registration.path)).state,
        "closed",
      );
      assert.deepEqual(pending_storage_operations(owner), []);
      await runtime.dispose();
      runtime = undefined;
    } finally {
      release.resolve();
      await probe;
      if (blocked_root && existsSync(blocked_root))
        await chmod(blocked_root, 0o700);
      await runtime?.dispose();
      await stopSubagentRpc();
      await local.close();
    }
  },
);

test(
  "native guardian recovers a real probe host after process-group SIGKILL and retries deletion refusal",
  supported,
  async () => {
    const release = gate();
    let entered = gate();
    const local = await localFixture(async () => {
      entered.resolve();
      await release.promise;
      return { content: "SHOULD_NOT_COMPLETE" };
    });
    const script = join(local.directory, "probe-host.mjs");
    await writeFile(
      script,
      `
import ${JSON.stringify(pathToFileURL(packagePath("scripts/test-runtime.mjs")).href)};
import { hostCodingAgent } from ${JSON.stringify(pathToFileURL(packagePath("bin/host-pi.mjs")).href)};
import { runForkProbe } from ${JSON.stringify(pathToFileURL(packagePath("src/lib/fork-probe.ts")).href)};
import { captureSessionOwner } from ${JSON.stringify(pathToFileURL(packagePath("src/lib/storage/owner.ts")).href)};
import { join } from 'node:path';
const host = await hostCodingAgent();
const manager = host.SessionManager.create(process.argv[2], join(process.argv[2], 'sessions'));
manager.appendModelChange('local-fixture', 'fixture');
manager.appendMessage({role:'user',content:'Hold the real probe until its host is killed.',timestamp:Date.now()});
process.send({owner:captureSessionOwner(manager)});
const result = await runForkProbe({parentSessionFile:manager.getSessionFile(),cwd:process.argv[2],timeoutMs:30000}, 'Describe your status.');
process.send({unexpectedResult:result});
`,
    );
    let child;
    let blocked_root;
    try {
      for (const refuse of [
        false,
        ...(process.getuid?.() !== 0 ? [true] : []),
      ]) {
        entered = gate();
        let diagnostics = "";
        child = spawn(process.execPath, [script, local.directory], {
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        for (const stream of [child.stdout, child.stderr])
          stream.on("data", (chunk) => {
            diagnostics = (diagnostics + chunk).slice(-8192);
          });
        const exited = once(child, "exit");
        const [message] = await Promise.race([
          once(child, "message"),
          exited.then(() => {
            throw new Error(
              `probe host exited before registration: ${diagnostics}`,
            );
          }),
        ]);
        assert.ok(message.owner);
        await Promise.race([
          entered.promise,
          exited.then(() => {
            throw new Error(`probe host exited before request: ${diagnostics}`);
          }),
        ]);
        const registration = await only_record(message.owner);
        assert.equal(registration.value.host_pid, child.pid);
        assert.equal(registration.value.closure_evidence, "none");
        assert.equal(
          existsSync(join(registration.value.path, "parent.snapshot")),
          true,
        );
        blocked_root = dirname(registration.value.path);
        if (refuse) await chmod(blocked_root, 0o500);
        process.kill(-child.pid, "SIGKILL");
        const [, signal] = await exited;
        assert.equal(signal, "SIGKILL");
        child = undefined;
        if (refuse) {
          await until(async () => {
            const record = await read_guardian_record(registration.path);
            return record.host_closed && record.error_name;
          }, "Guardian did not persist deletion refusal after host death");
          const pending = await read_guardian_record(registration.path);
          assert.equal(pending.state, "pending");
          assert.equal(pending.closure_evidence, "pidfd_exit");
          assert.equal(existsSync(registration.value.path), true);
          await chmod(blocked_root, 0o700);
        }
        await until(
          async () =>
            (await read_guardian_record(registration.path)).state === "closed",
          "Guardian did not remove the killed host's scratch",
        );
        const final = await read_guardian_record(registration.path);
        assert.equal(final.host_closed, true);
        assert.equal(final.closure_evidence, "pidfd_exit");
        assert.equal(existsSync(registration.value.path), false);
        blocked_root = undefined;
      }
    } finally {
      release.resolve();
      if (blocked_root && existsSync(blocked_root))
        await chmod(blocked_root, 0o700);
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "exit");
      }
      await local.close();
    }
  },
);
