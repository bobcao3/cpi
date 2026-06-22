import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as S from "./store";
import { globalDbPath, projectDbPath } from "../core/paths";

// Live refresh — the Stimulus/Hotwire analog for local-first SQLite. SQLite has
// no server-side push and sqlite3_update_hook only fires on the WRITING
// connection, so a second process (clidos, a subagent, later P2P sync) cannot
// be event-notified of changes. The SQLite-blessed cross-process signal is
// PRAGMA data_version: a single integer on a long-lived read connection that
// increments per commit by OTHER connections (see sqlite.org/c3ref and the
// `honker` LISTEN/NOTIFY extension, which uses exactly this).
//
// We hold one persistent read-only connection per DB (global + the open
// project) and poll data_version on a fixed interval; on any increment we
// bump the store's `rev` signal. The rev-keyed memos in every view then
// re-fetch and Solid re-renders — zero view changes: this is just a second
// source of rev bumps alongside the store's own writes. Our core opens a
// fresh connection per operation, so every write (TUI or clidos) is "another
// connection" to the poller and is detected uniformly.
//
// Bounded (TigerStyle): one timer, a fixed interval, explicit limits, no
// recursion. Overtriggering is intentional — a redundant refetch of
// unchanged data is a visual no-op, while a missed wake is a correctness
// bug. data_version (not max(audit_log.ts)) is defense-in-depth: it catches
// ANY external commit, even one that bypasses core.

const DEFAULT_INTERVAL_MS = 1500;

function dataVersion(db: Database): number {
  return (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
}

function openReadonly(file: string): Database | null {
  try {
    return new Database(file, { readonly: true });
  } catch {
    return null;
  }
}

export interface LivePollOpts {
  intervalMs?: number;
}

/** Start polling PRAGMA data_version on the global DB and the open project's
 *  DB; bump the store's `rev` when either changes. Re-watches the project DB
 *  when the open project changes. Returns a stop() that clears the timer and
 *  closes the connections. */
export function startLivePoll(opts: LivePollOpts = {}): () => void {
  const envMs = Number(process.env.TUIDOS_LIVE_INTERVAL_MS);
  const interval = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);

  let stopped = false;
  let gConn: Database | null = null;
  let gV = 0;
  let pConn: Database | null = null;
  let pV = 0;
  let pId: string | null = null; // last-seen project id (to detect a swap)

  const bump = () => { if (!stopped) S.setRev((r) => r + 1); };

  const tick = () => {
    if (stopped) return;
    // Global: (re)open lazily so a first-project-created-mid-session is caught.
    if (!gConn && existsSync(globalDbPath())) {
      gConn = openReadonly(globalDbPath());
      if (gConn) gV = dataVersion(gConn);
    }
    if (gConn) {
      const v = dataVersion(gConn);
      if (v !== gV) { gV = v; bump(); }
    }
    // Project: re-watch when the open project changes. Establishing a fresh
    // baseline on swap is NOT a bump (the open already refreshed the view).
    const cur = S.projectId();
    if (cur !== pId) {
      pConn?.close();
      pConn = null;
      pId = cur;
      if (cur && existsSync(projectDbPath(cur))) {
        pConn = openReadonly(projectDbPath(cur));
        if (pConn) pV = dataVersion(pConn);
      }
    }
    if (pConn) {
      const v = dataVersion(pConn);
      if (v !== pV) { pV = v; bump(); }
    }
  };

  const timer = setInterval(tick, interval);
  tick(); // establish baselines immediately (no bump: baseline == current)
  return () => {
    stopped = true;
    clearInterval(timer);
    gConn?.close(); gConn = null;
    pConn?.close(); pConn = null;
  };
}
