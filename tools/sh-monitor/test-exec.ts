#!/usr/bin/env bun
import {
  runShell,
  signalChild,
  detachChild,
  killAll,
  getActiveBackgrounds,
  setCompletionHook,
  setCurrentScope,
} from "../../extensions/shell/exec.ts";
import {
  buildShellEnv,
  buildShellEnvWithDotenv,
} from "../../extensions/shell/tools.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tunables = { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 50 };
const truncation = { maxLines: 1000 };
const env = { ...process.env };
delete env.PI_SESSION;
delete env.PI_SESSION_ID;
delete env.PI_SESSION_DIR;
setCurrentScope(undefined);

const completions: { id: string; code: number | null }[] = [];
setCompletionHook((id, _cmd, code) => {
  completions.push({ id, code });
});

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

let r = await runShell(
  "echo hello-world",
  5,
  env,
  undefined,
  undefined,
  "fast",
  30,
  truncation,
  tunables,
);
assert(r.status === "completed", "fast command status completed");
assert(r.exitCode === 0, "fast command exit 0");
assert(
  (r.text ?? "").includes("hello-world"),
  "fast command output present: " + r.text,
);
console.log("   fast text:", JSON.stringify(r.text));

r = await runShell(
  "exit 3",
  5,
  env,
  undefined,
  undefined,
  "fail",
  30,
  truncation,
  tunables,
);
assert(r.status === "completed" && r.exitCode === 3, "failing command exit 3");

r = await runShell(
  "printf 'BINARY:\\xff\\xfe\\x00END\\n'",
  5,
  env,
  undefined,
  undefined,
  "bin",
  30,
  truncation,
  tunables,
);
assert(
  r.status === "completed" && (r.text ?? "").includes("BINARY:"),
  "binary output present",
);
if (r.fullOutputPath) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(r.fullOutputPath);
  assert(
    buf.includes(0xff) && buf.includes(0xfe) && buf.includes(0x00),
    "raw 0xff 0xfe 0x00 preserved in log",
  );
}

r = await runShell(
  "for i in 1 2 3 4 5 6 7 8 9 10; do echo bg$i; sleep 0.2; done",
  0.5,
  env,
  undefined,
  undefined,
  "bg",
  30,
  truncation,
  tunables,
);
assert(
  r.status === "running" && !!r.id,
  "backgrounding returns running + id: " + JSON.stringify(r),
);
const bgId = r.id!;
console.log("   bg id:", bgId, "partial:", JSON.stringify(r.text));

const logPath = detachChild(bgId);
assert(!!logPath, "detach returns logPath");
assert(
  getActiveBackgrounds().every((b) => b.id !== bgId),
  "detached id gone from active list",
);
console.log("   detached logPath:", logPath);

assert(!signalChild(bgId, "SIGINT"), "signal on detached id fails");

const sessionDir = mkdtempSync(join(tmpdir(), "cpi-session-"));
const envPath = join(sessionDir, ".env");
writeFileSync(
  envPath,
  "PI_SESSION=stale-se\nPI_SESSION_ID=stale-session\nPI_SESSION_DIR=/tmp/stale-session\nPI_SUBAGENT=stale\nCPI_RUNTIME_BIN=/tmp/stale-runtime\nCPI_RUNTIME_KIND=stale\nCPI_SUBAGENT_RPC=/tmp/stale-rpc\nTEST_CAPTURE_VALUE=loaded\n",
);
const fakeSessionManager = {
  getSessionId: () => "current-session",
  getSessionDir: () => sessionDir,
};
const baselineEnv = buildShellEnv(fakeSessionManager);
setCurrentScope("current-session");
const scopedEnv = buildShellEnvWithDotenv(fakeSessionManager, envPath);
assert(scopedEnv.PI_SESSION === "current-", "scoped env has current short id");
assert(
  scopedEnv.PI_SESSION_ID === "current-session",
  "scoped env has current session id",
);
assert(
  scopedEnv.PI_SESSION_DIR === sessionDir,
  "scoped env has current session dir",
);
assert(scopedEnv.TEST_CAPTURE_VALUE === "loaded", "dotenv value loaded");
for (const key of [
  "PI_SUBAGENT",
  "CPI_RUNTIME_BIN",
  "CPI_RUNTIME_KIND",
  "CPI_SUBAGENT_RPC",
] as const) {
  assert(
    scopedEnv[key] === baselineEnv[key],
    `${key} preserves baseline value`,
  );
}

completions.length = 0;
r = await runShell(
  "for i in 1 2 3; do echo s$i; sleep 0.15; done",
  0.4,
  scopedEnv,
  undefined,
  undefined,
  "hook",
  30,
  truncation,
  tunables,
);
assert(r.status === "running", "hook-test backgrounded");
const hookId = r.id!;
const deadline = Date.now() + 5000;
while (completions.length === 0 && Date.now() < deadline)
  await new Promise((r) => setTimeout(r, 100));
assert(
  completions[0]?.id === hookId,
  "completion hook fired for backgrounded shell: " +
    JSON.stringify(completions[0]),
);

rmSync(sessionDir, { recursive: true, force: true });
killAll();
console.log("\nALL PASS");
