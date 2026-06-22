#!/usr/bin/env bun
/** Phase 2 harness: resume-socket bind on background, alive re-attach, ENOENT path. */
import {
  runShell,
  setCompletionHook,
  resumeBackgroundShells,
} from "../../extensions/shell/exec.ts";
import {
  ResumeClient,
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
const env = { ...process.env, PI_SESSION_DIR: sessDir, XDG_RUNTIME_DIR: xdgDir };

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
    const recs = await readResumeRecords(sessDir);
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

  // 3. ENOENT path: a bogus record → resumeBackgroundShells fires "resume-failed"
  let resumeFailId: string | null = null;
  setCompletionHook((id, _cmd, _code, reason) => {
    if (reason === "resume-failed") resumeFailId = id;
  });
  await writeResumeRecord(sessDir, "999999", "/tmp/pi-bogus-resume-" + Date.now() + ".sock", "bogus");
  await resumeBackgroundShells(sessDir); // 2s connect timeout per record
  const rfDl = Date.now() + 5000;
  while (resumeFailId === null && Date.now() < rfDl) await new Promise((res) => setTimeout(res, 50));
  ok(resumeFailId === "999999", "resume-failed fired for bogus record (got " + resumeFailId + ")");
  const leftover = await readResumeRecords(sessDir);
  ok(!leftover.find((x) => x.pid === "999999"), "bogus record removed after resume-failed");

  console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES: " + fail} (${pass} ok)`);
} finally {
  rmSync(sessDir, { recursive: true, force: true });
  rmSync(xdgDir, { recursive: true, force: true });
}
if (fail) process.exit(1);
