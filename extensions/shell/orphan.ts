import { readTarget } from "./ghostmux.ts";
import { ResumeClient } from "./monitor.ts";
import {
  completionDeliveryId,
  pendingCompletedRecords,
} from "./completion-delivery.ts";
import {
  readResumeRecords,
  writeCompletedRecord,
  type CompletedRecord,
  type ResumeRecord,
  shellRecords,
  shellTarget,
} from "./persistence.ts";
import { NOTIFICATION_TYPE } from "../lib/notification.ts";
import { queueMessage } from "../lib/prepend-message.ts";

const PROBE_TIMEOUT_MS = 300;

export interface OrphanedShell {
  pid: string;
  cmd: string;
  sessionId: string;
}

async function probeAlive(sockPath: string): Promise<boolean> {
  const c = new ResumeClient(sockPath);
  try {
    await Promise.race([
      c.whenReady,
      new Promise<void>((_, rej) =>
        setTimeout(() => rej(new Error("probe timeout")), PROBE_TIMEOUT_MS),
      ),
    ]);
    return !(await readTarget(sockPath)).completed;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

async function probeRecords(
  records: (ResumeRecord & { sessionId: string })[],
): Promise<OrphanedShell[]> {
  const alive: OrphanedShell[] = [];
  for (let i = 0; i < records.length; i += 16) {
    await Promise.all(
      records.slice(i, i + 16).map(async (r) => {
        if (await probeAlive(r.sockPath))
          alive.push({ pid: r.pid, cmd: r.cmd, sessionId: r.sessionId });
      }),
    );
  }
  return alive;
}

export async function discoverShellsForScope(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<OrphanedShell[]> {
  if (!sessionDir || !scope) return [];
  const records = (await readResumeRecords(sessionDir, scope)).map((r) => ({
    ...r,
    sessionId: scope,
  }));
  return probeRecords(records);
}

export function formatOrphanedSummary(orphans: OrphanedShell[]): string {
  const n = orphans.length;
  const head = `${n} orphaned background shell${n !== 1 ? "s" : ""} from this session`;
  const list = orphans
    .map((o) => `[${o.pid} ${o.cmd} (sess ${o.sessionId.slice(0, 8)})]`)
    .join(" ");
  return `${head}: ${list}`;
}

export function notifyOrphanedShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<void> {
  return discoverShellsForScope(sessionDir, scope).then((orphans) => {
    if (orphans.length === 0) return;
    const summary = formatOrphanedSummary(orphans);
    queueMessage({
      customType: NOTIFICATION_TYPE,
      content: summary,
      display: true,
      details: {
        kind: "orphaned-shells",
        summary,
        payload: { shells: orphans },
      },
      sessionId: scope,
      deliverAs: "beforeUser",
    });
  });
}

export function formatCompletedSummary(recs: CompletedRecord[]): string {
  const n = recs.length;
  const head = `${n} background shell${n !== 1 ? "s" : ""} completed while you were away`;
  const list = recs
    .map((r) => `[${r.pid} ${r.command} exited ${r.exitCode}]`)
    .join(" ");
  return `${head}: ${list}`;
}

export async function surfaceCompletedShells(
  sessionDir: string | undefined,
  scope: string | undefined,
  sessionFile: string | undefined = undefined,
): Promise<void> {
  if (!sessionDir || !scope) return;
  for (const record of shellRecords(scope).filter(
    (record) => record.status === "running",
  )) {
    try {
      const target = await shellTarget(record);
      if (!target.completed) continue;
      await writeCompletedRecord(scope, {
        id: record.id,
        pid: record.pid,
        command: record.command,
        exitCode: target.exitCode ?? -1,
        logPath: target.logPath,
        completedAt: Date.now(),
      });
    } catch {}
  }
  for (const record of await pendingCompletedRecords(
    sessionDir,
    scope,
    sessionFile,
  )) {
    const summary = formatCompletedSummary([record]);
    queueMessage({
      customType: NOTIFICATION_TYPE,
      content: summary,
      display: true,
      details: {
        kind: "completed-shells",
        summary,
        payload: { shells: [record] },
      },
      sessionId: scope,
      deliveryId: completionDeliveryId(scope, record),
      deliverAs: "beforeUser",
    });
  }
}
