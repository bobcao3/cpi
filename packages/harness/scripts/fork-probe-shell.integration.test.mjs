import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { runForkProbe } from "../src/lib/fork-probe.ts";
import { getSubagentRpc, stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { registerHoldSource } from "../src/lib/session-hold.ts";
import { disposeAll } from "../src/lib/lsp/manager.ts";
import { localFixture } from "./local-fixture.mjs";
import {
  createHarness,
  until,
} from "./shell-persistence.integration.helper.mjs";
import { assertLocalModel, packagePath } from "./test-runtime.mjs";

const execute = promisify(execFile);
const host = await hostCodingAgent();

test(
  "fork probe shutdown cannot terminate parent background shells",
  { timeout: 60000 },
  async () => {
    const cacheRetention = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = "long";
    const local = await localFixture(() => ({ content: "PROBE_OK" }));
    const modelsPath = join(local.agentDir, "models.json");
    const models = JSON.parse(await readFile(modelsPath, "utf8"));
    models.providers["local-fixture"].models[0].compat = {
      supportsLongCacheRetention: true,
    };
    await writeFile(modelsPath, JSON.stringify(models));
    const manager = host.SessionManager.create(
      local.directory,
      join(local.directory, "sessions"),
    );
    manager.appendModelChange("local-fixture", "fixture");
    manager.appendMessage({
      role: "user",
      content: "Keep the background jobs running.",
      timestamp: Date.now(),
    });
    const harness = createHarness(host, packagePath(""), local.agentDir);
    const runtime = await harness.runtimeFor(manager, [
      packagePath("src/core.ts"),
    ]);
    const launched = [];
    try {
      assertLocalModel(runtime.session.model, local.baseUrl);
      await runtime.session.prompt("Initialize the parent session.");
      for (const name of ["first", "second"])
        launched.push(
          await harness.launch(
            runtime.session,
            name,
            30000,
            join(local.directory, `${name}.done`),
          ),
        );
      const original = await readFile(manager.getSessionFile(), "utf8");
      const result = await runForkProbe(
        {
          parentSessionFile: manager.getSessionFile(),
          cwd: local.directory,
          timeoutMs: 15000,
        },
        "Summarize the work without changing background jobs.",
      );
      for (const job of launched) {
        const native = JSON.parse(
          await readFile(job.details.statusPath, "utf8"),
        );
        assert.equal(
          native.session.exit_code,
          null,
          "Probe disposal must leave the parent's shell running",
        );
        assert.equal(native.server_pid, job.details.serverPid);
      }
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.answer, "PROBE_OK");
      assert.equal(await readFile(manager.getSessionFile(), "utf8"), original);
      assert.equal(local.requests.length, 2);
      assert.equal(local.requests[1].prompt_cache_key, manager.getSessionId());
    } finally {
      await stopSubagentRpc();
      await runtime.dispose();
      await disposeAll();
      for (const job of launched)
        await execute(
          job.details.binaryPath,
          ["-S", job.details.socketPath, "kill-server"],
          { timeout: 5000 },
        ).catch(() => {});
      await local.close();
      if (cacheRetention === undefined) delete process.env.PI_CACHE_RETENTION;
      else process.env.PI_CACHE_RETENTION = cacheRetention;
    }
  },
);

test(
  "headless quit drains admitted probe continuations but refuses a new CLI admission",
  { timeout: 30000 },
  async () => {
    let hold = false;
    let release;
    let announce;
    const ready = new Promise((resolve) => {
      announce = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const local = await localFixture(async () => {
      if (hold) {
        announce();
        await gate;
      }
      return { content: "DRAINED_PROBE" };
    });
    const marker = join(local.directory, "cleanup-prepared");
    const observer = join(local.directory, "cleanup-observer.ts");
    await writeFile(
      observer,
      `import {writeFileSync} from 'node:fs'; export default function(pi) {
    pi.on('session_cleanup', event => {
      if(event.phase === 'prepare' && event.reason === 'quit') writeFileSync(${JSON.stringify(marker)}, 'prepared');
    });
  }`,
    );
    const manager = host.SessionManager.create(
      local.directory,
      join(local.directory, "sessions"),
    );
    manager.appendModelChange("local-fixture", "fixture");
    manager.appendMessage({
      role: "user",
      content: "Finish the admitted work before quitting.",
      timestamp: Date.now(),
    });
    const harness = createHarness(host, packagePath(""), local.agentDir);
    const runtime = await harness.runtimeFor(
      manager,
      [packagePath("src/core.ts"), observer],
      "print",
    );
    let unregister;
    let work;
    let closing;
    let active = true;
    const controller = new AbortController();
    try {
      await runtime.session.prompt("Initialize the headless session.");
      hold = true;
      work = (async () => {
        for (let index = 0; index < 2; index++) {
          const result = await runForkProbe(
            {
              parentSessionFile: manager.getSessionFile(),
              cwd: local.directory,
              signal: controller.signal,
              timeoutMs: 10000,
            },
            "Describe your status.",
          );
          assert.equal(result.ok, true, JSON.stringify(result));
        }
      })().finally(() => {
        active = false;
      });
      void work.catch(() => {});
      await Promise.race([
        ready,
        work.then(() => {
          throw new Error("probe never reached the model");
        }),
      ]);
      unregister = registerHoldSource({
        id: "owned-probe-chain",
        hasPending: () => active,
        noticeText: () => "owned probes",
        deadlineMs: 15000,
        onAbort: () => controller.abort(),
      });
      closing = runtime.dispose();
      void closing.catch(() => {});
      await until(() => existsSync(marker), "Cleanup prepare did not run");
      await assert.rejects(
        execute(
          process.execPath,
          [
            packagePath("bin/subagent.js"),
            "-s",
            "drain-refusal",
            "Must not start a new job.",
          ],
          {
            cwd: local.directory,
            env: { ...process.env, CPI_SUBAGENT_RPC: getSubagentRpc() },
            timeout: 5000,
          },
        ),
        (error) => /draining/.test(error.stderr),
      );
      assert.equal(controller.signal.aborted, false);
      release();
      await work;
      await closing;
      assert.equal(local.requests.length, 3);
    } finally {
      release();
      controller.abort();
      await work?.catch(() => {});
      unregister?.();
      await (closing ?? runtime.dispose()).catch(() => {});
      await stopSubagentRpc();
      await local.close();
    }
  },
);
