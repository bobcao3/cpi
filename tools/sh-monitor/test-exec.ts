#!/usr/bin/env bun
/** Direct harness: jiti-loads the real shell/exec.ts and exercises runShell. */
import {
  runShell,
  signalChild,
  silenceChild,
  detachChild,
  killAll,
  getActiveBackgrounds,
  setCompletionHook,
} from "../../extensions/shell/exec.ts";

const tunables = { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 50 };
const truncation = { maxLines: 1000 };
const env = { ...process.env };

let hookFired: { id: string; code: number | null } | null = null;
setCompletionHook((id, _cmd, code) => {
  hookFired = { id, code };
});

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

// 1. fast foreground command — must return completed with output
let r = await runShell("echo hello-world", 5, env, undefined, undefined, "fast", 30, truncation, tunables);
assert(r.status === "completed", "fast command status completed");
assert(r.exitCode === 0, "fast command exit 0");
assert((r.text ?? "").includes("hello-world"), "fast command output present: " + r.text);
console.log("   fast text:", JSON.stringify(r.text));

// 2. failing command — exit code propagated
r = await runShell("exit 3", 5, env, undefined, undefined, "fail", 30, truncation, tunables);
assert(r.status === "completed" && r.exitCode === 3, "failing command exit 3");

// 3. binary-safe output (non-UTF8 bytes)
r = await runShell("printf 'BINARY:\\xff\\xfe\\x00END\\n'", 5, env, undefined, undefined, "bin", 30, truncation, tunables);
assert(r.status === "completed" && (r.text ?? "").includes("BINARY:"), "binary output present");
// verify the log file (fullOutputPath) has the raw bytes
if (r.fullOutputPath) {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(r.fullOutputPath);
  assert(buf.includes(0xff) && buf.includes(0xfe) && buf.includes(0x00), "raw 0xff 0xfe 0x00 preserved in log");
}

// 4. backgrounding: a command longer than waitfor → running, returns id
r = await runShell("for i in 1 2 3 4 5 6 7 8 9 10; do echo bg$i; sleep 0.2; done", 0.5, env, undefined, undefined, "bg", 30, truncation, tunables);
assert(r.status === "running" && !!r.id, "backgrounding returns running + id: " + JSON.stringify(r));
const bgId = r.id!;
console.log("   bg id:", bgId, "partial:", JSON.stringify(r.text));

// 5. detach it — must succeed, child keeps running, no longer in active list
const logPath = detachChild(bgId);
assert(!!logPath, "detach returns logPath");
assert(getActiveBackgrounds().every((b) => b.id !== bgId), "detached id gone from active list");
console.log("   detached logPath:", logPath);

// 6. signal on detached id must fail (not active)
assert(!signalChild(bgId, "SIGINT"), "signal on detached id fails");

// 7. a backgrounded (non-detached) command completes and fires the hook
hookFired = null;
r = await runShell("for i in 1 2 3; do echo s$i; sleep 0.15; done", 0.4, env, undefined, undefined, "hook", 30, truncation, tunables);
assert(r.status === "running", "hook-test backgrounded");
const hookId = r.id!;
// wait for the completion hook to fire
const deadline = Date.now() + 5000;
while (!hookFired && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
assert(hookFired && hookFired.id === hookId, "completion hook fired for backgrounded shell: " + JSON.stringify(hookFired));

// 8. killAll cleans up anything left
killAll();
console.log("\nALL PASS");
