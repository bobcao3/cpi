#!/usr/bin/env bun
/** Phase 2 harness: resume-socket bind on background, alive re-attach, ENOENT path. */
import {
  runShell,
  setCompletionHook,
  setCurrentScope,
  resumeBackgroundShells,
  getShellBackgrounds,
  signalChild,
  killAll,
} from "../../extensions/shell/exec.ts";
import {
  ResumeClient,
  launchMonitor,
  readResumeRecords,
  writeResumeRecord,
} from "../../extensions/shell/monitor.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tunables = { previewMaxBytes: 4096, maxAcc: 65536, updateMs: 50 };
const truncation = { maxLines: 1000 };
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log("ok:", m); }
  else { fail++; console.error("FAIL:", m); }
};

const sessDir = mkdtempSync(join(tmpdir(), "pi-resume-sess-"));
const xdgDir = mkdtempSync(join(tmpdir(), "pi-resume-xdg-"));
const scope = "test-scope";
const env = { ...process.env, PI_SESSION_DIR: sessDir, PI_SESSION_ID: scope, XDG_RUNTIME_DIR: xdgDir };

try {
  // 1. background a long shell → exec.ts asks sh-monitor to bindResume + writes a record
  const r = await runShell(
    'for i in 1 2 3 4 5 6 7 8; do echo "r$i"; sleep 0.25; done',
    0.5, env, undefined, undefined, "bg-resume", 30, truncation, tunables,
  );
  ok(r.status === "running" && !!r.id, "backgrounded (status=" + r.status + ")");
  const bgId = r.id!;

  // poll for the resume record (bindResume + writeResumeRecord are async)
  let record: { pid: string; sockPath: string; cmd: string } | null = null;
  const dl = Date.now() + 5000;
  while (Date.now() < dl) {
    const recs = await readResumeRecords(sessDir, scope);
    record = recs.find((x) => x.pid === bgId) ?? null;
    if (record) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  ok(!!record, "resume record written for bg id " + bgId);
  if (record) ok(record.sockPath.endsWith(".sock"), "record sockPath valid: " + record.sockPath);

  // 2. alive re-attach: a resumed pi connects to the still-running shell's resume socket
  if (record) {
    const rc = new ResumeClient(record.sockPath);
    let saw = "", exited: number | null = null;
    await rc.whenReady; // rejects (ENOENT/ECONNREFUSED) if the supervisor is gone
    rc.subscribe((ev) => {
      if (ev.kind === "data") saw += ev.buf.toString("utf8");
      else exited = ev.exitCode;
    });
    const exitDl = Date.now() + 10000;
    while (exited === null && Date.now() < exitDl) await new Promise((res) => setTimeout(res, 50));
    ok(exited === 0, "resume client saw exit 0 (got " + exited + ")");
    ok(/r[1-8]/.test(saw), "resume client received live DATA: " + JSON.stringify(saw.slice(0, 60)));
    rc.close();
  }

  // 3. SILENT cleanup: a stale/bogus record is cleaned up silently (no completion hook fires)
  let hookFired = false;
  setCompletionHook((_id, _cmd, _code, _reason) => {
    hookFired = true;
  });
  await writeResumeRecord(sessDir, scope, "999999", "/tmp/pi-bogus-resume-" + Date.now() + ".sock", "bogus");
  await resumeBackgroundShells(sessDir, scope); // 2s connect timeout per record
  ok(!hookFired, "stale resume record cleaned up silently (no completion hook)");
  const leftover = await readResumeRecords(sessDir, scope);
  ok(!leftover.find((x) => x.pid === "999999"), "stale resume record removed");

  // 4. resume re-attaches a still-living shell as a FULLY managed background entry
  //    (listable + signalable), reusing the same completion path as in-process shells.
  //    bg starts empty (fresh process): launch a shell, write its record, "exit" pi
  //    (close the pipe — sh-monitor survives while the grandchild runs), then resume.
  setCurrentScope(scope);
  setCompletionHook(() => {});
  const h = await launchMonitor("sleep 30", env, `${Date.now()}-resume-mgmt`);
  const rst = await h.client.stat();
  const rpid = String(rst.pid);
  const rsock = await h.client.bindResume();
  ok(!!rsock, "launchMonitor bound a resume socket");
  await writeResumeRecord(sessDir, scope, rpid, rsock!, "sleep 30", h.logPath, "resume-mgmt");
  ok(getShellBackgrounds().length === 0, "bg empty before resume (fresh process)");
  h.client.close(); // simulate pi exit; sh-monitor survives while the grandchild runs
  await resumeBackgroundShells(sessDir, scope);
  ok(getShellBackgrounds().some((e) => e.id === rpid), "resumed shell is listed in bg (manageable)");
  ok(signalChild(rpid, "SIGINT") === true, "resumed shell is signalable via the resume socket");
  killAll();
  ok(getShellBackgrounds().length === 0, "killAll removed the resumed shell from bg");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass} ok)`);
} finally {
  rmSync(sessDir, { recursive: true, force: true });
  rmSync(xdgDir, { recursive: true, force: true });
}
// force exit: section 4 simulates a prior process via launchMonitor, whose
// MonitorClient stdout-pipe handle needs a tick to release on natural exit.
process.exit(fail ? 1 : 0);
