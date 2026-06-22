/**
 * cost-tree socket: Unix-domain socket for recursive cost roll-up across the
 * pi process tree.
 *
 * Each pi process (via the cost-tree extension) creates a listening socket and
 * re-points CPI_COST_SOCKET to it for its children. At shutdown a child
 * connects to its inherited (parent) socket and sends its subtree total (own
 * usage + aggregated descendants). The parent's listener parses + records it.
 * Recursion: each node reports its subtree once to its immediate parent;
 * grandchildren report to the child (whose env they inherited), never the root
 * directly → no double counting.
 *
 * Best-effort: a child that crashes before shutdown sends nothing (diagnostic
 * only). Sockets live in a per-process mktemp dir with 0600 perms.
 *
 * Wire format (one line): `cpi-cost in=<n> out=<n> cost=$<x>\n`
 *
 * Pure leaf: node:net/fs/os/path only.
 */

import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CostReport {
  input: number;
  output: number;
  cost: number;
}

const WIRE_PREFIX = "cpi-cost";
const WIRE_RE = /cpi-cost\s+in=(\d+)\s+out=(\d+)\s+cost=\$?([0-9]+(?:\.[0-9]+)?)/;

/** Parse one wire line; undefined if it doesn't match. */
export function parseCostReport(line: string): CostReport | undefined {
  const m = line.match(WIRE_RE);
  if (!m) return undefined;
  return { input: parseInt(m[1], 10), output: parseInt(m[2], 10), cost: parseFloat(m[3]) };
}

/** Render one wire line. */
export function renderCostReport(r: CostReport): string {
  return `${WIRE_PREFIX} in=${r.input} out=${r.output} cost=$${r.cost}\n`;
}

/**
 * Create a listening Unix socket for children to report into. `onReport` is
 * called per completed child connection with the parsed subtree report. Returns
 * the socket path + a close() that shuts the server and unlinks the temp dir.
 */
export function createCostSocket(onReport: (r: CostReport) => void): { path: string; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cpi-cost-"));
  const path = join(dir, "sock");
  const server: Server = createServer((sock: Socket) => {
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
    });
    sock.on("end", () => {
      const r = parseCostReport(buf);
      if (r) onReport(r);
    });
    sock.on("error", () => {
      // best effort: a malformed/aborted connection never breaks cost tracking
    });
  });
  server.listen(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // best effort: perms are defense-in-depth on a single-user dev box
  }
  const close = (): void => {
    try {
      server.close();
    } catch {
      // best effort
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  };
  return { path, close };
}

/**
 * Best-effort send of a subtree report to the parent's socket. Resolves on
 * delivery, timeout, or error (never rejects) — cost tracking is diagnostic.
 */
export function sendCostReport(parentSocket: string, r: CostReport, timeoutMs = 1000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let sock: Socket | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        sock?.destroy();
      } catch {
        // best effort
      }
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      sock = connect(parentSocket, () => {
        try {
          sock?.end(renderCostReport(r));
        } catch {
          // best effort
        }
      });
    } catch {
      clearTimeout(timer);
      return resolve();
    }
    sock.on("error", () => {
      clearTimeout(timer);
      finish();
    });
    sock.on("close", () => {
      clearTimeout(timer);
      finish();
    });
  });
}
