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
const WIRE_RE =
  /cpi-cost\s+in=(\d+)\s+out=(\d+)\s+cost=\$?([0-9]+(?:\.[0-9]+)?)/;

export function parseCostReport(line: string): CostReport | undefined {
  const m = line.match(WIRE_RE);
  if (!m) return undefined;
  return {
    input: parseInt(m[1], 10),
    output: parseInt(m[2], 10),
    cost: parseFloat(m[3]),
  };
}

export function renderCostReport(r: CostReport): string {
  return `${WIRE_PREFIX} in=${r.input} out=${r.output} cost=$${r.cost}\n`;
}

export function createCostSocket(onReport: (r: CostReport) => void): {
  path: string;
  close: () => void;
} {
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
    sock.on("error", () => {});
  });
  server.listen(path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // perms are defense-in-depth on a single-user dev box
  }
  const close = (): void => {
    try {
      server.close();
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };
  return { path, close };
}

/**
 * Best-effort send of a subtree report to the parent's socket. Resolves on
 * delivery, timeout, or error (never rejects) — cost tracking is diagnostic.
 */
export function sendCostReport(
  parentSocket: string,
  r: CostReport,
  timeoutMs = 1000,
): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let sock: Socket | undefined;
    const finish = (): void => {
      if (done) return;
      done = true;
      try {
        sock?.destroy();
      } catch {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      sock = connect(parentSocket, () => {
        try {
          sock?.end(renderCostReport(r));
        } catch {}
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
