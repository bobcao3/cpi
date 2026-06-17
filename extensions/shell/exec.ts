/**
 * Shell execution engine.
 *
 * Drives `bash -c <command>` as a detached process group, captures merged
 * stdout+stderr (RAM-capped tail; a logfile holds the full output), and races
 * the child's exit against a `waitfor` deadline. If the command finishes in
 * time it returns inline; otherwise it is registered as a background child
 * keyed by its process-group PID, signalable by that PID, and fires a
 * completion hook when it eventually exits.
 *
 * Pure node — no pi/tui/typebox imports. The PATH-augmented env is passed in by
 * the caller so this module stays decoupled from tool installation.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";

const PREVIEW_MAX_BYTES = 10 * 1024;
const PREVIEW_MAX_LINES = 500;
const MAX_ACC_BYTES = 4 * 1024 * 1024; // RAM cap on the merged accumulator; logfile holds full output.
const WAITFOR_CAP_SEC = 30;
const UPDATE_INTERVAL_MS = 200;

interface BackgroundChild {
  id: string; // process-group PID as string (== pid)
  pid: number; // process-group leader (detached)
  command: string;
  describe?: string; // short agent-provided description of the command's purpose
  child: ChildProcess;
  acc: string; // merged stdout+stderr accumulator, 4MB tail-capped
  logPath: string; // full output appended live
  logStream: WriteStream;
  startedAt: number;
  exitCode: number | null;
  done: boolean; // set-once guard
  signaled?: boolean; // true when the agent explicitly signaled it; suppresses the completion notice
  // Full-output position written to the logfile so far (NOT subject to the acc cap).
  bytesEmitted: number; // total bytes appended to logPath
  linesEmitted: number; // total newlines seen
  colBytes: number; // bytes since the last newline (column on the current line)
}

export interface OutputCursor {
  line: number; // 1-based line currently being written
  column: number; // 0-based byte offset into the current line
  bytes: number; // total bytes written to the logfile so far
}

const backgrounded = new Map<string, BackgroundChild>();

export interface OutputSnapshot {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
  outputBytes: number;
  lastLinePartial: boolean;
  fullOutputPath?: string;
}

export interface ShResult {
  id: string | null; // null = finished inline, no background id
  status: "completed" | "running";
  exitCode: number | null;
  text: string; // built via buildOutputText
  snapshot: OutputSnapshot;
  fullOutputPath?: string;
  cursor?: OutputCursor; // present when status === "running": resume point in fullOutputPath
}

export type CompletionHook = (id: string, command: string, exitCode: number | null) => void;

let completionHook: CompletionHook | undefined;

export function setCompletionHook(fn: CompletionHook): void {
  completionHook = fn;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

async function buildOutputText(
  accumulated: string,
  options: { persistIfTruncated?: boolean; emptyText?: string; logPath?: string } = {},
): Promise<{ text: string; snapshot: OutputSnapshot; fullOutputPath?: string }> {
  const { persistIfTruncated = true, emptyText = "(no output)", logPath } = options;
  const snapshot = truncateTail(accumulated, {
    maxBytes: PREVIEW_MAX_BYTES,
    maxLines: PREVIEW_MAX_LINES,
  });
  let text = snapshot.content || emptyText;
  let fullOutputPath: string | undefined;
  if (snapshot.truncated) {
    const startLine = snapshot.totalLines - snapshot.outputLines + 1;
    const endLine = snapshot.totalLines;
    if (snapshot.lastLinePartial) {
      const lastNl = accumulated.lastIndexOf("\n");
      const lastLineBytes = Buffer.byteLength(
        lastNl === -1 ? accumulated : accumulated.slice(lastNl + 1),
        "utf-8",
      );
      text += `\n\n[tail ${formatSize(snapshot.outputBytes)} of L${endLine} (L=${formatSize(lastLineBytes)}).`;
    } else if (snapshot.truncatedBy === "lines") {
      text += `\n\n[L${startLine}-${endLine}/${snapshot.totalLines}.`;
    } else {
      text += `\n\n[L${startLine}-${endLine}/${snapshot.totalLines} (${formatSize(PREVIEW_MAX_BYTES)} cap).`;
    }
    if (persistIfTruncated) {
      fullOutputPath = logPath ?? join(tmpdir(), `pi-sh-output-${Date.now()}.log`);
      if (!logPath) await writeFile(fullOutputPath, accumulated);
      text += ` full: ${fullOutputPath}`;
    }
    text += "]";
  }
  return { text, snapshot: snapshot as unknown as OutputSnapshot, fullOutputPath };
}

function resolveBash(): string {
  return existsSync("/bin/bash") ? "/bin/bash" : "bash";
}

export async function runShell(
  command: string,
  waitforSec: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onPartial?: (text: string) => void,
  describe?: string,
): Promise<ShResult> {
  const child = spawn(resolveBash(), ["-c", command], {
    detached: true, // child is process-group leader → process.kill(-pid) hits the whole group
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // The background id IS the process-group PID, so the model can monitor it directly.
  const pid = child.pid ?? -1;
  const id = String(pid);
  const logPath = join(tmpdir(), `pi-sh-output-${id}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });

  const entry: BackgroundChild = {
    id,
    pid,
    command,
    describe,
    child,
    acc: "",
    logPath,
    logStream,
    startedAt: Date.now(),
    exitCode: null,
    done: false,
    bytesEmitted: 0,
    linesEmitted: 0,
    colBytes: 0,
  };

  let lastUpdateAt = 0;
  const onChunk = (chunk: Buffer) => {
    logStream.write(chunk);
    // Track the full-output cursor before the acc tail-cap drops any history.
    entry.bytesEmitted += chunk.length;
    let lastNl = -1;
    for (let i = chunk.indexOf(0x0a); i !== -1; i = chunk.indexOf(0x0a, i + 1)) {
      entry.linesEmitted++;
      lastNl = i;
    }
    entry.colBytes = lastNl === -1 ? entry.colBytes + chunk.length : chunk.length - 1 - lastNl;
    entry.acc += chunk.toString("utf8");
    const bytes = Buffer.byteLength(entry.acc);
    if (bytes > MAX_ACC_BYTES) {
      const buf = Buffer.from(entry.acc, "utf8");
      entry.acc = buf.subarray(buf.length - MAX_ACC_BYTES).toString("utf8");
    }
    const now = Date.now();
    if (onPartial && now - lastUpdateAt >= UPDATE_INTERVAL_MS) {
      lastUpdateAt = now;
      void buildOutputText(entry.acc, { persistIfTruncated: false }).then((r) => onPartial(r.text));
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  // Attach the exit handler at spawn so even fast-path children are reaped.
  const exitPromise = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (!entry.done) {
        entry.done = true;
        entry.exitCode = code;
        entry.logStream.end();
        // Only notify for children that overflowed into the background; drop the
        // registry entry so a recycled PID never collides with a stale one.
        if (backgrounded.has(id)) {
          if (!entry.signaled) {
            completionHook?.(id, command, code);
          }
          backgrounded.delete(id);
        }
      }
      resolve();
    });
    child.on("error", () => {
      if (!entry.done) {
        entry.done = true;
        entry.logStream.end();
      }
      resolve();
    });
  });

  const onAbort = () => {
    if (pid > 0) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // best effort
      }
    }
  };
  signal?.addEventListener("abort", onAbort);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlinePromise = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.min(waitforSec, WAITFOR_CAP_SEC) * 1000);
  });

  const finishedFirst = await Promise.race([
    exitPromise.then(() => true),
    deadlinePromise.then(() => false),
  ]);

  signal?.removeEventListener("abort", onAbort);
  if (timer) clearTimeout(timer);

  if (finishedFirst || entry.done) {
    // Fast path: child exited (or was aborted) before the deadline. Not registered.
    const { text, snapshot, fullOutputPath } = await buildOutputText(entry.acc, { logPath });
    if (!fullOutputPath) await rm(logPath, { force: true }).catch(() => {});
    return {
      id: null,
      status: "completed",
      exitCode: entry.exitCode,
      text,
      snapshot,
      fullOutputPath,
    };
  }

  // Overflow path: still running at the deadline. Register and keep it detached.
  backgrounded.set(id, entry);
  const { text, snapshot } = await buildOutputText(entry.acc, { logPath });
  return {
    id,
    status: "running",
    exitCode: null,
    text,
    snapshot,
    fullOutputPath: logPath,
    cursor: { line: entry.linesEmitted + 1, column: entry.colBytes, bytes: entry.bytesEmitted },
  };
}

export function signalChild(id: string, signal: string): boolean {
  const entry = backgrounded.get(id);
  if (!entry || entry.done) return false;
  const sig = /^\d+$/.test(signal) ? Number(signal) : (signal as NodeJS.Signals);
  try {
    // Negative pid signals the whole process group. The exit handler fires the
    // completion notice and cleans up the registry once the group dies.
    process.kill(-entry.pid, sig);
  } catch {
    return false;
  }
  return true;
}

export function silenceChild(id: string): boolean {
  const entry = backgrounded.get(id);
  if (!entry || entry.done) return false;
  entry.signaled = true;
  return true;
}

export function getActiveBackgroundIds(): string[] {
  return Array.from(backgrounded.keys());
}

export function getActiveBackgrounds(): { id: string; describe?: string }[] {
  return Array.from(backgrounded.values()).map((entry) => ({
    id: entry.id,
    describe: entry.describe,
  }));
}

export function hasActiveBackground(): boolean {
  return backgrounded.size > 0;
}

export function killAll(): void {
  for (const entry of backgrounded.values()) {
    if (entry.done) continue;
    entry.done = true;
    try {
      process.kill(-entry.pid, "SIGKILL");
    } catch {
      // best effort
    }
    entry.logStream.end();
  }
  backgrounded.clear();
}
