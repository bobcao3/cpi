import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import * as S from "./store";
import { globalDbPath, projectDbPath } from "../core/paths";

// Live refresh: SQLite update hooks are connection-local, so polling PRAGMA
// data_version is required to catch commits from other processes.

const DEFAULT_INTERVAL_MS = 1500;

function dataVersion(db: Database): number {
  return (db.prepare("PRAGMA data_version").get() as { data_version: number })
    .data_version;
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

/** Poll PRAGMA data_version on the global and project DBs, bump `rev` on
 *  external changes, re-watch the project DB when the open project changes,
 *  and return a stop() that clears the timer and closes the connections. */
export function startLivePoll(opts: LivePollOpts = {}): () => void {
  const envMs = Number(process.env.TUIDOS_LIVE_INTERVAL_MS);
  const interval =
    opts.intervalMs ??
    (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);

  let stopped = false;
  let gConn: Database | null = null;
  let gV = 0;
  let pConn: Database | null = null;
  let pV = 0;
  let pId: string | null = null;

  const bump = () => {
    if (!stopped) S.setRev((r) => r + 1);
  };

  const tick = () => {
    if (stopped) return;
    if (!gConn && existsSync(globalDbPath())) {
      gConn = openReadonly(globalDbPath());
      if (gConn) gV = dataVersion(gConn);
    }
    if (gConn) {
      const v = dataVersion(gConn);
      if (v !== gV) {
        gV = v;
        bump();
      }
    }
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
      if (v !== pV) {
        pV = v;
        bump();
      }
    }
  };

  const timer = setInterval(tick, interval);
  tick();
  return () => {
    stopped = true;
    clearInterval(timer);
    gConn?.close();
    gConn = null;
    pConn?.close();
    pConn = null;
  };
}
