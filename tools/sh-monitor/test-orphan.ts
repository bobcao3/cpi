#!/usr/bin/env bun
/**
 * Clean-fork semantics + orphaned/forked shell discovery + completion suppression.
 *  - in-memory live tracking is scoped by conversation session id (a fork does
 *    not see or manage the parent's background shells);
 *  - a fork inherits nothing: completion notices for the parent's shells are
 *    suppressed while the fork is active; only the owning session gets them;
 *  - discoverOrphanedShells lists alive shells owned by other sessions;
 *  - discoverShellsForScope lists one session's alive shells (fork-notice core).
 */
import {
  runShell,
  setCompletionHook,
  setCurrentScope,
  signalChild,
  killAll,
  getShellBackgrounds,
} from "../../extensions/shell/exec.ts";
import { discoverOrphanedShells, discoverShellsForScope, formatCompletedSummary, surfaceCompletedShells } from "../../extensions/shell/orphan.ts";
import { readCompletedRecords, readResumeRecords, writeResumeRecord } from "../../extensions/shell/monitor.ts";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const sessDir = mkdtempSync(join(tmpdir(), "pi-orphan-sess-"));
const xdgDir = mkdtempSync(join(tmpdir(), "pi-orphan-xdg-"));
const A = "sess-a",
  B = "sess-b";
const env = (scope: string) => ({
  ...process.env,
  PI_SESSION_DIR: sessDir,
  PI_SESSION_ID: scope,
  XDG_RUNTIME_DIR: xdgDir,
});
const truncation = { maxLines: 1000 };
const tunables = { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 50 };

const calls: { id: string; reason: string }[] = [];
setCompletionHook((id, _cmd, _code, reason) =>
  calls.push({ id, reason: String(reason) }),
);

const waitMarker = async (m: string): Promise<boolean> => {
  const dl = Date.now() + 8000;
  while (Date.now() < dl) {
    if (existsSync(m)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
const marker = (n: string) => `/tmp/pi-orphan-marker-${n}-${Date.now()}`;

try {
  // 1. background a long shell owned by A
  setCurrentScope(A);
  const r = await runShell(
    'sleep 30',
    0.4, env(A), undefined, undefined, "orphan-bg", 30, truncation, tunables,
  );
  ok(r.status === "running" && !!r.id, "backgrounded in session A (status=" + r.status + ")");
  const id = r.id!;
  const dl = Date.now() + 5000;
  while (Date.now() < dl) {
    if ((await readResumeRecords(sessDir, A)).some((x) => x.pid === id)) break;
    await new Promise((res) => setTimeout(res, 50));
  }

  // 2. clean fork: A sees its shell; B does not; B cannot signal it
  ok(getShellBackgrounds().some((e: { id: string }) => e.id === id), "A sees its own background shell");
  setCurrentScope(B);
  ok(getShellBackgrounds().length === 0, "forked session B sees none of A's shells (clean fork)");
  ok(signalChild(id, "SIGINT") === false, "forked session B cannot signal A's shell");

  // 3. orphaned discovery: B finds A's alive shell; A does not list its own
  const fromB = await discoverOrphanedShells(sessDir, B);
  ok(
    fromB.some((o: { pid: string; sessionId: string }) => o.pid === id && o.sessionId === A),
    "B discovers A's alive shell as orphaned",
  );
  const fromA = await discoverOrphanedShells(sessDir, A);
  ok(!fromA.some((o: { pid: string }) => o.pid === id), "A does not list its own shell as orphaned");

  // 4. discoverShellsForScope (fork-notice core): A's shells, not B's
  const aShells = await discoverShellsForScope(sessDir, A);
  ok(aShells.some((o: { pid: string }) => o.pid === id), "discoverShellsForScope(A) returns A's alive shell");
  ok((await discoverShellsForScope(sessDir, B)).length === 0, "discoverShellsForScope(B) returns none");

  // 5. stale record from a dead session is cleaned, not listed
  await writeResumeRecord(sessDir, "sess-c", "999999", "/tmp/pi-bogus-orphan-" + Date.now() + ".sock", "bogus");
  ok((await readResumeRecords(sessDir, "sess-c")).length === 1, "stale record present under sess-c");
  const orphansWithStale = await discoverOrphanedShells(sessDir, A);
  ok(!orphansWithStale.some((o: { pid: string }) => o.pid === "999999"), "stale (dead) shell not listed");
  ok((await readResumeRecords(sessDir, "sess-c")).length === 0, "stale record from dead session removed silently");

  // 6. completion suppression: fork inherits nothing; only the owner gets notices
  // 6a. shell owned by A completes while B (fork) is active -> suppressed
  setCurrentScope(B);
  const m2 = marker("b");
  const r2 = await runShell(
    `sleep 0.5; echo done > ${m2}`, 0.2, env(A), undefined, undefined, "supp-b", 30, truncation, tunables,
  );
  ok(r2.status === "running" && !!r2.id, "backgrounded A-owned shell while B active (status=" + r2.status + ")");
  const id2 = r2.id!;
  ok(await waitMarker(m2), "A-owned shell completed while B active");
  await new Promise((res) => setTimeout(res, 150));
  ok(!calls.some((c) => c.id === id2), "completion suppressed for fork (B inherits nothing)");

  // 6b. shell owned by A completes while A is active -> owner gets the notice
  setCurrentScope(A);
  const m3 = marker("a");
  const r3 = await runShell(
    `sleep 0.5; echo done > ${m3}`, 0.2, env(A), undefined, undefined, "supp-a", 30, truncation, tunables,
  );
  ok(r3.status === "running" && !!r3.id, "backgrounded A-owned shell while A active (status=" + r3.status + ")");
  const id3 = r3.id!;
  ok(await waitMarker(m3), "A-owned shell completed while A active");
  await new Promise((res) => setTimeout(res, 150));
  ok(calls.some((c) => c.id === id3), "owner (A) gets the completion notice when active");

  // 7. completed-shell markers: off-screen completions persist + surface on resume.
  //    6a wrote a marker for id2 (suppressed); 6b wrote none for id3 (owner active).
  const doneA = await readCompletedRecords(sessDir, A);
  ok(
    doneA.some((r) => r.pid === id2 && r.exitCode === 0),
    "suppressed completion persisted a marker (id2, exit 0)",
  );
  ok(!doneA.some((r) => r.pid === id3), "owner-active completion wrote no marker (id3)");
  const summary = formatCompletedSummary(doneA);
  ok(
    /completed while you were away/.test(summary) && summary.includes(id2),
    "formatCompletedSummary mentions 'away' + the pid",
  );
  await surfaceCompletedShells(sessDir, A);
  ok(
    (await readCompletedRecords(sessDir, A)).length === 0,
    "surfaceCompletedShells consumed the markers (one-shot)",
  );

  // cleanup: kill A's remaining shells (scoped killAll affects only current session A)
  setCurrentScope(A);
  killAll();

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass} ok)`);
} finally {
  rmSync(sessDir, { recursive: true, force: true });
  rmSync(xdgDir, { recursive: true, force: true });
}
if (fail) process.exit(1);
