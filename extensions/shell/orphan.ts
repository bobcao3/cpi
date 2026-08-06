/**
 * Background-shell liveness probing on session start: connect to the sh-monitor
 * resume socket without subscribing — `whenReady` resolves on connect (alive),
 * rejects on ENOENT/ECONNREFUSED (dead); dead records are stale debris, removed
 * silently.
 */

import {
  ResumeClient,
  readCompletedRecords,
  readResumeRecords,
  removeCompletedRecord,
  removeResumeRecord,
  type CompletedRecord,
  type ResumeRecord,
} from "./monitor.ts";
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
    return true;
  } catch {
    return false;
  } finally {
    c.close();
  }
}

async function probeRecords(
  sessionDir: string,
  records: (ResumeRecord & { sessionId: string })[],
): Promise<OrphanedShell[]> {
  const alive: OrphanedShell[] = [];
  await Promise.all(
    records.map(async (r) => {
      if (await probeAlive(r.sockPath))
        alive.push({ pid: r.pid, cmd: r.cmd, sessionId: r.sessionId });
      else void removeResumeRecord(sessionDir, r.sessionId, r.pid);
    }),
  );
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
  return probeRecords(sessionDir, records);
}

export function formatOrphanedSummary(orphans: OrphanedShell[]): string {
  const n = orphans.length;
  const head = `${n} orphaned background shell${n !== 1 ? "s" : ""} from this session`;
  const list = orphans
    .map((o) => `[${o.pid} ${o.cmd} (sess ${o.sessionId.slice(0, 8)})]`)
    .join(" ");
  return `${head}: ${list}`;
}

/** On session start: list this exact session's alive orphaned shells. */
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
): Promise<void> {
  if (!sessionDir || !scope) return;
  const recs = await readCompletedRecords(sessionDir, scope);
  if (recs.length === 0) return;
  const summary = formatCompletedSummary(recs);
  queueMessage({
    customType: NOTIFICATION_TYPE,
    content: summary,
    display: true,
    details: { kind: "completed-shells", summary, payload: { shells: recs } },
    deliverAs: "beforeUser",
  });
  await Promise.all(
    recs.map((r) => removeCompletedRecord(sessionDir, scope, r.pid)),
  );
}
