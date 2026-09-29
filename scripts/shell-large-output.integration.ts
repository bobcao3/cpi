import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { runShell, setCurrentScope } from "../extensions/shell/exec.ts";

const scope = `large-output-${Date.now()}`;
setCurrentScope(scope);
const expected = 70 * 1024 * 1024;
const result = await runShell(
  `head -c ${expected} /dev/zero`,
  30,
  { ...process.env, PI_SESSION_ID: scope },
  undefined,
  undefined,
  "Large durable log",
  30,
  { maxLines: 10 },
  { maxAcc: 8192, previewMaxBytes: 4096, updateMs: 50 },
);
assert.equal(result.status, "completed");
assert.notEqual(result.exitCode, 0);
assert.equal(result.backendError, "LogLimit");
const stored = (await stat(result.fullOutputPath!)).size;
assert(stored > 0 && stored <= 64 * 1024 * 1024);
assert(Buffer.byteLength(result.text) < 8192);
console.log("Shell enforces the existing log byte budget and reports LogLimit");
