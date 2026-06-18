/**
 * Shuck LSP-based command linting — main-thread wrapper.
 *
 * Spawns a Worker thread (lsp-worker.mjs) that owns the shuck LSP server.
 * All LSP I/O runs in the Worker's dedicated event loop (1:1 with server).
 * No temp files. No per-call process spawning. No race conditions.
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const TIMEOUT = 10_000;
const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), "lsp-worker.mjs");

export interface ShuckDiagnostic {
  code: string; severity: "error" | "warning" | "hint"; message: string;
  location: { row: number; column: number };
  end_location: { row: number; column: number };
  filename: string;
}
export interface LintResult { errors: ShuckDiagnostic[]; warnings: ShuckDiagnostic[]; available: boolean }

class ShuckLspClient {
  private w: Worker | null = null;
  private ready: Promise<boolean> | null = null;
  private nextId = 1;
  private pending = new Map<number, (d: ShuckDiagnostic[]) => void>();

  constructor(private shuckPath: string) {}

  async lint(command: string): Promise<ShuckDiagnostic[]> {
    // Ensure worker is ready
    if (!this.w) {
      if (!this.ready) {
        this.ready = (async () => {
          this.w = new Worker(WORKER_PATH, { workerData: { shuckPath: this.shuckPath } });
          this.w.on("message", (msg: any) => {
            if (msg.type === "result") { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); p(msg.diagnostics); } }
            else if (msg.type === "error") { const p = this.pending.get(msg.id); if (p) { this.pending.delete(msg.id); p([]); } }
          });
          this.w.on("error", (e) => console.warn("[shell-ext] shuck LSP worker error:", e));
          this.w.on("exit", () => { this.w = null; this.ready = null; this.pending.forEach((p) => p([])); this.pending.clear(); });
          return new Promise<boolean>((resolve) => {
            const onReady = (msg: any) => { if (msg.type === "ready") { this.w!.off("message", onReady); resolve(true); } };
            this.w!.on("message", onReady);
            this.w!.once("error", () => resolve(false));
          });
        })();
      }
      const ok = await this.ready;
      if (!ok) { this.ready = null; this.w = null; return []; }
    }

    const id = this.nextId++;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.pending.delete(id); resolve([]); }, TIMEOUT);
      this.pending.set(id, (d) => { clearTimeout(t); resolve(d); });
      this.w!.postMessage({ type: "lint", id, command });
    });
  }

  dispose() { this.w?.postMessage({ type: "dispose" }); this.w = null; this.ready = null; }
}

let client: ShuckLspClient | null = null;

export function disposeLspClient(): void { client?.dispose(); client = null; }

export function formatDiagnostics(d: ShuckDiagnostic[]): string {
  return d.map((x) => `  L${x.location.row}:${x.location.column} ${x.severity}[${x.code}] ${x.message}`).join("\n");
}

export async function lintCommand(command: string, shuckPath: string): Promise<LintResult> {
  if (!client) client = new ShuckLspClient(shuckPath);
  const diags = await client.lint(command);
  return { errors: diags.filter((d) => d.severity === "error"), warnings: diags.filter((d) => d.severity === "warning"), available: true };
}
