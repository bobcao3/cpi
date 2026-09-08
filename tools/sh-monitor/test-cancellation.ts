import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getActiveBackgrounds,
  killAll,
  runShell,
  setCompletionHook,
  setCurrentScope,
} from "../../extensions/shell/exec.ts";

const directory = mkdtempSync(join(tmpdir(), "cpi-shell-cancellation-"));
const env = { ...process.env };
delete env.PI_SESSION;
delete env.PI_SESSION_ID;
delete env.PI_SESSION_DIR;
setCurrentScope(undefined);
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
      "for i in {1..300}; do echo ready; sleep 0.1; done",
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
