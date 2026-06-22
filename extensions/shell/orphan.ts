/**
 * Orphaned & forked background-shell discovery.
 *
 * Resume records are scoped per conversation (`<sessionDir>/sh-mon/<sessionId>/`),
 * so a shell belongs to exactly one session. On session start:
 *  - resumeBackgroundShells (in exec.ts) re-attaches the CURRENT session's own
 *    shells (alive) and silently cleans its stale records.
 *  - here we surface shells owned by OTHER sessions — "discoverable but
 *    orphaned" from the current session's view. They were started by a fork's
 *    parent, a previous/exited pi, or a concurrent agent in the same cwd.
 *
 * A fork inherits nothing: no live shells, no completion notices (those go only
 * to the owning/parent session when it is active). Instead the fork gets a
 * one-time notice — "Session is forked, shell PIDs: [...] still belongs to the
 * parent session" — listing the parent's alive shells so the user knows where
 * they went.
 *
 * Liveness is probed by connecting to the sh-monitor resume socket WITHOUT
 * subscribing: `ResumeClient.whenReady` resolves on connect (alive) or rejects
 * on ENOENT/ECONNREFUSED (dead). The probe socket coexists harmlessly with a
 * real (owning) subscriber and never forces an exit while the grandchild runs.
 * Dead records are stale debris and are removed silently (no notification).
 */

import {
  ResumeClient,
  readAllResumeRecords,
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

/** Probe records; return the alive ones and silently remove the dead (stale). */
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

/** Alive shells owned by sessions OTHER than `scope` (the current session). */
export async function discoverOrphanedShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<OrphanedShell[]> {
  if (!sessionDir) return [];
  const records = (await readAllResumeRecords(sessionDir)).filter(
    (r) => r.sessionId !== scope,
  );
  return probeRecords(sessionDir, records);
}

/** Alive shells owned by exactly one session `scope`. */
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

/** One-line, user-facing summary of orphaned shells. */
export function formatOrphanedSummary(orphans: OrphanedShell[]): string {
  const n = orphans.length;
  const head = `${n} orphaned background shell${n !== 1 ? "s" : ""} from other session${
    n !== 1 ? "s" : ""
  } still running in this directory`;
  const list = orphans
    .map((o) => `[${o.pid} ${o.cmd} (sess ${o.sessionId.slice(0, 8)})]`)
    .join(" ");
  return `${head}: ${list}`;
}

/** Extract the session id (uuid) from a `<timestamp>_<uuid>.jsonl` file name. */
function parseSessionId(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  return sessionFile.match(/_([^/]+)\.jsonl$/)?.[1];
}

/** On fork: tell the forked session which shells stayed with the parent. */
export function notifyForkedShells(
  sessionDir: string | undefined,
  previousSessionFile: string | undefined,
): Promise<void> {
  const parentScope = parseSessionId(previousSessionFile);
  return discoverShellsForScope(sessionDir, parentScope).then((shells) => {
    if (shells.length === 0) return;
    const pids = shells.map((s) => s.pid).join(" ");
    const summary = `Session is forked, shell PIDs: [${pids}] still belongs to the parent session`;
    queueMessage({
      customType: NOTIFICATION_TYPE,
      content: summary,
      display: true,
      details: { kind: "orphaned-shells", summary, payload: { shells } },
      deliverAs: "beforeUser",
    });
  });
}

/** On (non-fork) session start: list other sessions' alive orphaned shells. */
export function notifyOrphanedShells(
  sessionDir: string | undefined,
  scope: string | undefined,
): Promise<void> {
  return discoverOrphanedShells(sessionDir, scope).then((orphans) => {
    if (orphans.length === 0) return;
    const summary = formatOrphanedSummary(orphans);
    queueMessage({
      customType: NOTIFICATION_TYPE,
      content: summary,
      display: true,
      details: { kind: "orphaned-shells", summary, payload: { shells: orphans } },
      deliverAs: "beforeUser",
    });
  });
}


/** One-line summary of shells that completed while the owner was away. */
export function formatCompletedSummary(recs: CompletedRecord[]): string {
  const n = recs.length;
  const head = `${n} background shell${n !== 1 ? "s" : ""} completed while you were away`;
  const list = recs
    .map((r) => `[${r.pid} ${r.command} exited ${r.exitCode}]`)
    .join(" ");
  return `${head}: ${list}`;
}

/**
 * On (non-fork) session start: surface shells that completed while the owning
 * session was away (recorded by a suppressed completion), then consume the
 * markers. Delivered `beforeUser` so it appears as early as resume.
 */
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
  await Promise.all(recs.map((r) => removeCompletedRecord(sessionDir, scope, r.pid)));
}
