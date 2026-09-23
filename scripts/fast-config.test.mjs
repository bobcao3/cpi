import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { initializeFastModels, resolveFastModel } from "../bin/fast-models.mjs";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { fixture } from "./fast-fixture.mjs";

const { resolveCliModel } = await hostCodingAgent();

test("worker SDK loading rejects unknown host provenance", () => {
  const entry = new URL("../bin/host-pi.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { activePiRoot } from ${JSON.stringify(entry)}; activePiRoot()`,
    ],
    {
      encoding: "utf8",
      timeout: 3000,
      env: { PATH: "/usr/bin", _: process.execPath },
    },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Cannot identify the active Pi package/);
});

test("removing fast eligibility fails closed for a persisted model", async () => {
  await fixture(async ({ runtime, directory, requests }) => {
    const stale = runtime.getModel("openai", "gpt-5.5-fast");
    assert.ok(stale);
    await writeFile(
      join(directory, ".pi/cpi-config.json"),
      JSON.stringify({ fast: { providers: [], models: [] } }),
    );
    await initializeFastModels(runtime, directory);
    assert.equal(runtime.getModel("openai", "gpt-5.5-fast"), undefined);
    assert.throws(
      () =>
        resolveFastModel(resolveCliModel, {
          cliProvider: "openai",
          cliModel: "gpt-5.5-fast",
          modelRuntime: runtime,
        }),
      /Fast model unavailable/,
    );
    const response = await runtime.completeSimple(
      stale,
      { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] },
      { maxTokens: 32 },
    );
    assert.equal(response.stopReason, "error");
    assert.match(response.errorMessage, /unavailable/);
    assert.equal(requests.length, 0);
  });
});
