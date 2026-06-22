#!/usr/bin/env bun
/**
 * Repeat monitors are session-scoped, mirroring background shells: a fork
 * inherits none of the parent's repeats (not listed, not signalable, not killed
 * by the fork's killAllRepeats). Repeats remain in-memory/ephemeral (not
 * resumable) — only their ownership is scoped.
 */
import { setCurrentScope } from "../../extensions/shell/exec.ts";
import {
  startRepeat,
  signalRepeat,
  getActiveRepeats,
  getRepeatCount,
  killAllRepeats,
} from "../../extensions/shell/repeat.ts";

let pass = 0,
  fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) {
    pass++;
    console.log("ok:", m);
  } else {
    fail++;
    console.error("FAIL:", m);
  }
};

const A = "sess-a",
  B = "sess-b";
const env = { ...process.env };
try {
  setCurrentScope(A);
  const id = startRepeat("echo hi", 60, env, "rpt-A");
  ok(getActiveRepeats().some((r) => r.id === id), "A sees its own repeat");
  ok(getRepeatCount() === 1, "A's repeat count is 1");

  // fork (B) inherits nothing: no repeats visible, can't signal
  setCurrentScope(B);
  ok(getActiveRepeats().length === 0, "forked B sees none of A's repeats (clean fork)");
  ok(getRepeatCount() === 0, "B's repeat count is 0");
  ok(signalRepeat(id, "SIGKILL") === false, "B cannot signal A's repeat");

  // back to A: the repeat survived the fork and is still manageable
  setCurrentScope(A);
  ok(getActiveRepeats().some((r) => r.id === id), "A still sees its repeat after the fork");
  ok(signalRepeat(id, "SIGKILL") === true, "A can signal (stop) its repeat");
  ok(getRepeatCount() === 0, "A's repeat removed after signaling");

  // killAllRepeats is scoped: B's killAll must not touch A's repeats
  startRepeat("echo hi", 60, env, "rpt-A2");
  startRepeat("echo hi", 60, env, "rpt-A3");
  setCurrentScope(A);
  ok(getRepeatCount() === 2, "A has 2 repeats");
  setCurrentScope(B);
  killAllRepeats();
  setCurrentScope(A);
  ok(getRepeatCount() === 2, "B's killAllRepeats did not touch A's repeats (scoped)");
  killAllRepeats();
  ok(getRepeatCount() === 0, "A's killAllRepeats cleared A's repeats");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass} ok)`);
} catch (e) {
  console.error("ERROR:", e);
  fail++;
}
process.exit(fail ? 1 : 0);
