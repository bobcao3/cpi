import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell, setCurrentScope } from "../src/shell/exec.ts";
import { resolveShell } from "../src/shell/profile.ts";
import { nodeProgram } from "./shell-platform.mjs";

const scope = `large-output-${Date.now()}`;
setCurrentScope(scope);
const expected = 70 * 1024 * 1024;
const directory = await mkdtemp(join(tmpdir(), "cpi-output-limit-"));
try {
  const result = await runShell(
    await nodeProgram(
      directory,
      "output",
      `import { writeSync } from 'node:fs'; const bytes = Buffer.alloc(65536); for (let i = 0; i < ${expected / 65536}; i++) writeSync(1, bytes);`,
    ),
    30,
    { ...process.env, PI_SESSION_ID: scope },
    undefined,
    undefined,
    "Large durable log",
    30,
    { maxLines: 10 },
    { maxAcc: 8192, previewMaxBytes: 4096, updateMs: 50 },
    resolveShell(),
  );
  assert.equal(result.status, "completed");
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.backendError, "LogLimit");
  const stored = (await stat(result.fullOutputPath!)).size;
  assert(stored > 0 && stored <= 64 * 1024 * 1024);
  assert(Buffer.byteLength(result.text) < 8192);
  console.log(
    "Shell enforces the existing log byte budget and reports LogLimit",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
