import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShellDialect } from "./profile.ts";
export {
  MonitorClient,
  ResumeClient,
  launchMonitor,
} from "./ghostmux-client.ts";
export type { MonitorEvent, MonitorHandle } from "./ghostmux-client.ts";
const RESUME_SUBDIR = "sh-mon";

export interface ResumeRecord {
  pid: string;
  sockPath: string;
  cmd: string;
  logPath?: string;
  describe?: string;
  dialect?: ShellDialect;
}

function resumeRecordDir(sessionDir: string, scope: string): string {
  return join(sessionDir, RESUME_SUBDIR, scope);
}

export async function writeResumeRecord(
  sessionDir: string,
  scope: string,
  pid: string,
  sockPath: string,
  cmd: string,
  logPath?: string,
  describe?: string,
  dialect?: ShellDialect,
): Promise<void> {
  try {
    const dir = resumeRecordDir(sessionDir, scope);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `${pid}.json`),
      JSON.stringify({ pid, sockPath, cmd, logPath, describe, dialect }) + "\n",
    );
  } catch {}
}

export async function readResumeRecords(
  sessionDir: string,
  scope: string,
): Promise<ResumeRecord[]> {
  const dir = resumeRecordDir(sessionDir, scope);
  try {
    const files = await readdir(dir);
    const out: ResumeRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          await readFile(join(dir, f), "utf8"),
        ) as ResumeRecord;
        if (rec && rec.pid && rec.sockPath) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeResumeRecord(
  sessionDir: string,
  scope: string,
  pid: string,
): Promise<void> {
  try {
    await unlink(join(resumeRecordDir(sessionDir, scope), `${pid}.json`));
  } catch {}
}

export interface CompletedRecord {
  pid: string;
  command: string;
  exitCode: number;
  logPath: string;
  completedAt: number;
}

function completedRecordDir(sessionDir: string, scope: string): string {
  return join(resumeRecordDir(sessionDir, scope), "done");
}

/** Persist an off-screen completion so the owner's resume can surface it. */
export async function writeCompletedRecord(
  sessionDir: string,
  scope: string,
  pid: string,
  rec: CompletedRecord,
): Promise<void> {
  try {
    const dir = completedRecordDir(sessionDir, scope);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${pid}.json`), JSON.stringify(rec) + "\n");
  } catch {}
}

export async function readCompletedRecords(
  sessionDir: string,
  scope: string,
): Promise<CompletedRecord[]> {
  const dir = completedRecordDir(sessionDir, scope);
  try {
    const files = await readdir(dir);
    const out: CompletedRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(
          await readFile(join(dir, f), "utf8"),
        ) as CompletedRecord;
        if (rec && rec.pid) out.push(rec);
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

export async function removeCompletedRecord(
  sessionDir: string,
  scope: string,
  pid: string,
): Promise<void> {
  try {
    await unlink(join(completedRecordDir(sessionDir, scope), `${pid}.json`));
  } catch {}
}
