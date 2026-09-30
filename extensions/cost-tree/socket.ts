import { createServer, connect, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validReport, type CostReport } from "../lib/cost-accounting.ts";
export type { CostReport } from "../lib/cost-accounting.ts";

const MAX_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 32;
const TIMEOUT_MS = 1000;

export function parseCostReport(line: string): CostReport | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return validReport(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function renderCostReport(r: CostReport): string {
  if (!validReport(r)) throw new Error("Invalid cost report");
  return `${JSON.stringify(r)}\n`;
}

export function createCostSocket(onReport: (r: CostReport) => void): {
  path: string;
  ready: Promise<void>;
  close: () => void;
} {
  const isWindows = process.platform === "win32";
  let dir: string | undefined;
  let path: string;
  if (isWindows) {
    path = `\\\\.\\pipe\\cpi-cost-${process.pid}-${randomBytes(16).toString("hex")}`;
  } else {
    dir = mkdtempSync(join(tmpdir(), "cpi-cost-"));
    chmodSync(dir, 0o700);
    path = join(dir, "sock");
  }

  const sockets = new Set<Socket>();
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const server: Server = createServer(
    { allowHalfOpen: true },
    (sock: Socket) => {
      if (sockets.size >= MAX_CONNECTIONS) {
        sock.destroy();
        return;
      }
      sockets.add(sock);
      sock.unref();
      const timer = setTimeout(() => sock.destroy(), TIMEOUT_MS);
      timer.unref();
      const buffer = Buffer.allocUnsafe(MAX_BYTES);
      let bytes = 0;
      sock.on("data", (d: Buffer) => {
        bytes += d.length;
        if (bytes > MAX_BYTES) {
          sock.destroy();
          return;
        }
        d.copy(buffer, bytes - d.length);
      });
      sock.on("end", () => {
        const report = parseCostReport(
          buffer.subarray(0, bytes).toString("utf8"),
        );
        if (!report) {
          sock.destroy();
          return;
        }
        try {
          onReport(report);
          sock.end("ok\n");
        } catch {
          sock.destroy();
        }
      });
      sock.on("close", () => {
        clearTimeout(timer);
        sockets.delete(sock);
      });
      sock.on("error", () => {});
    },
  );
  server.maxConnections = MAX_CONNECTIONS;
  server.unref();
  server.on("error", (error) => rejectReady(error));
  server.listen(path, () => {
    try {
      if (!isWindows) chmodSync(path, 0o600);
      resolveReady();
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });

  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const sock of sockets) sock.destroy();
    server.close();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
  return { path, ready, close };
}

export function sendCostReport(
  parentSocket: string,
  r: CostReport,
  timeoutMs = TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let sock: Socket | undefined;
    let ack = "";
    const finish = (success: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve(success);
    };
    let payload: string;
    try {
      if (!validReport(r)) return resolve(false);
      payload = renderCostReport(r);
      if (Buffer.byteLength(payload) > MAX_BYTES) return resolve(false);
    } catch {
      return resolve(false);
    }
    const timer = setTimeout(
      () => finish(false),
      Math.min(1000, Math.max(1, timeoutMs)),
    );
    try {
      sock = connect(parentSocket, () => sock?.end(payload));
    } catch {
      finish(false);
      return;
    }
    sock.on("data", (data: Buffer) => {
      ack += data.toString("utf8");
      if (Buffer.byteLength(ack) > 16) finish(false);
    });
    sock.on("end", () => finish(ack === "ok\n"));
    sock.on("error", () => finish(false));
    sock.on("close", () => finish(false));
  });
}
