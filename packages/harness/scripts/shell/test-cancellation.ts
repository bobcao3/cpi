import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveShell } from "../../src/shell/profile.ts";
import { shellCommand } from "../shell-platform.mjs";
import {
  getActiveBackgrounds,
  killAll,
  runShell,
  setCompletionHook,
  setCurrentScope,
} from "../../src/shell/exec.ts";

const testScope = `shell-test-${randomUUID()}`;
process.env.PI_SESSION_ID = testScope;
delete process.env.CPI_GHOSTMUX_SOCKET;

const directory = mkdtempSync(join(tmpdir(), "cpi-shell-cancellation-"));
const env = { ...process.env };
delete env.PI_SESSION;
env.PI_SESSION_ID = testScope;
delete env.PI_SESSION_DIR;
setCurrentScope(testScope);
const completions: string[] = [];
setCompletionHook((id) => completions.push(id));
const run = (
  command: string,
  signal?: AbortSignal,
  update?: (text: string) => void,
) =>
  runShell(
    command,
    3,
    env,
    signal,
    update,
    "cancellation",
    30,
    { maxLines: 100 },
    { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 0 },
    resolveShell(),
  );

try {
  const preAborted = new AbortController();
  preAborted.abort();
  const marker = join(directory, "should-not-exist");
  const skipped = await run(`echo launched > '${marker}'`, preAborted.signal);
  assert.equal(skipped.status, "completed");
  assert.equal(skipped.exitCode, -1);
  assert.equal(existsSync(marker), false);

  for (const phase of ["startup", "running"] as const) {
    const controller = new AbortController();
    const start = Date.now();
    const pending = run(
      shellCommand(
        "while true; do echo ready; sleep 0.1; done",
        "1..300 | ForEach-Object { Write-Output ready; Start-Sleep -Milliseconds 100 }",
      ),
      controller.signal,
      phase === "running"
        ? (text) => {
            if (text.includes("ready")) controller.abort();
          }
        : undefined,
    );
    if (phase === "startup") controller.abort();
    const result = await pending;
    assert.equal(controller.signal.aborted, true);
    assert.equal(
      result.status,
      "completed",
      `${phase}: must not background cancelled work`,
    );
    assert.equal(result.exitCode, 137);
    assert.ok(
      Date.now() - start < 2500,
      `${phase}: must not wait for waitfor timeout`,
    );
    assert.deepEqual(getEventListeners(controller.signal, "abort"), []);
    assert.deepEqual(getActiveBackgrounds(), []);
    assert.deepEqual(completions, []);
    console.log(`PASS ${phase} cancellation released shell wait`);
  }

  const next = await run("echo recovered");
  assert.equal(next.exitCode, 0);
  assert.match(next.text, /recovered/);
  console.log(
    "PASS pre-aborted shell never launched; subsequent shell succeeds",
  );
} finally {
  killAll();
  rmSync(directory, { recursive: true, force: true });
}
