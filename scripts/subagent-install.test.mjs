import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fixture } from "./fast-fixture.mjs";
import { subagentEnvironment } from "../extensions/lib/activity-subagent.ts";

test("installed subagent worker uses the active Pi SDK without a local Pi peer", async () => {
  await fixture(async ({ directory, modelsPath, requests }) => {
    const install = await mkdtemp(join(tmpdir(), "cpi-installed-worker-"));
    try {
      await cp(resolve("bin"), join(install, "bin"), { recursive: true });
      await cp(resolve("extensions/lib"), join(install, "extensions/lib"), {
        recursive: true,
      });
      await cp(resolve("extensions/text"), join(install, "extensions/text"), {
        recursive: true,
      });
      await copyFile(
        resolve("cpi-config.default.json"),
        join(install, "cpi-config.default.json"),
      );
      await writeFile(join(install, "package.json"), '{"type":"module"}');
      await mkdir(join(install, "node_modules"));
      for (const name of ["mustache", "smol-toml"]) {
        await symlink(
          resolve("node_modules", name),
          join(install, "node_modules", name),
        );
      }
      await assert.rejects(
        lstat(join(install, "node_modules/@earendil-works")),
        { code: "ENOENT" },
      );
      await copyFile(modelsPath, join(directory, "models.json"));
      const credits = new Int32Array(new SharedArrayBuffer(4));
      const request = {
        version: 1,
        kind: "session",
        runId: randomUUID(),
        cwd: directory,
        env: { ...process.env, _: "" },
        extensionPaths: [],
        tools: [],
        systemPrompt: "Reply OK.",
        task: "Reply OK.",
        provider: "openai",
        modelId: "gpt-5.5",
        thinkingLevel: "off",
        maxTurns: 1,
        maxOutputBytes: 4096,
      };
      delete request.env.CPI_PI_HOST_ENTRY;
      const env = subagentEnvironment(request, "unused");
      assert.equal(
        env.CPI_PI_HOST_ENTRY,
        await realpath(process.env.CPI_PI_HOST_ENTRY),
      );
      const worker = new Worker(join(install, "bin/subagent-worker.js"), {
        execArgv: [],
        workerData: { ...request, observationCredits: credits.buffer },
        env: { ...env, PI_CODING_AGENT_DIR: directory },
        stdout: true,
        stderr: true,
      });
      let diagnostics = "";
      let terminal;
      let timer;
      worker.stderr.on("data", (chunk) => (diagnostics += chunk));
      try {
        await new Promise((resolveWorker, reject) => {
          timer = setTimeout(
            () => reject(new Error("worker timed out")),
            15000,
          );
          worker.on("message", (event) => {
            if (event.kind === "run_event") {
              Atomics.sub(credits, 0, 1);
              Atomics.notify(credits, 0);
              if (event.type === "terminal") terminal = event;
            } else if (event.kind === "candidate") {
              worker.postMessage({ kind: "finish" });
            } else if (event.kind === "done") {
              clearTimeout(timer);
              if (event.exitCode)
                reject(
                  new Error(diagnostics || terminal?.error || "worker failed"),
                );
              else resolveWorker();
            }
          });
          worker.once("error", reject);
          worker.once("exit", (code) => {
            if (code) reject(new Error(diagnostics || `worker exited ${code}`));
          });
        });
        assert.equal(terminal?.outcome, "completed", diagnostics);
        assert.equal(terminal?.answer, "OK");
        assert.equal(requests.length, 1);
      } finally {
        clearTimeout(timer);
        await worker.terminate();
      }
    } finally {
      await rm(install, { recursive: true, force: true });
    }
  });
});
