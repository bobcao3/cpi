/**
 * Shell execution engine — spawns bash, manages background processes,
 * fires completion hooks. Pure node, no pi/tui imports.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, type WriteStream } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { truncateTail } from "@earendil-works/pi-coding-agent";
import {
  getActiveRepeats,
  hasActiveRepeats,
  killAllRepeats,
  setRepeatCompletionHook,
  signalRepeat,
} from "./repeat.ts";

const PREVIEW_MAX_BYTES = 10 * 1024,
  PREVIEW_MAX_LINES = 500,
  MAX_ACC = 4 * 1024 * 1024,
  UPDATE_MS = 200;

interface BackgroundChild {
  id: string;
  pid: number;
  command: string;
  describe?: string;
  child: ChildProcess;
  acc: string;
  logPath: string;
  logStream: WriteStream;
  exitCode: number | null;
  done: boolean;
  signaled?: boolean;
  bytesEmitted: number;
  linesEmitted: number;
  colBytes: number;
}

export interface OutputCursor {
  line: number;
  column: number;
  bytes: number;
}

export interface ShResult {
  id: string | null;
  status: "completed" | "running";
  exitCode: number | null;
  text: string;
  fullOutputPath?: string;
  cursor?: OutputCursor;
}

export type CompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "triggered" | "breach",
  log?: { path: string; startLine?: number; endLine?: number },
) => void;

const bg = new Map<string, BackgroundChild>();
let completionHook: CompletionHook | undefined;

export const setCompletionHook = (fn: CompletionHook) => {
  completionHook = fn;
  setRepeatCompletionHook(fn);
};

const fmtSize = (b: number) =>
  b < 1024 ? `${b}B` : b < 1048576 ? `${(b / 1024).toFixed(1)}KB` : `${(b / 1048576).toFixed(1)}MB`;

export async function buildOutputText(
  acc: string,
  opts: { persistIfTruncated?: boolean; emptyText?: string; logPath?: string } = {},
): Promise<{ text: string; fullOutputPath?: string }> {
  const { persistIfTruncated = true, emptyText = "(no output)", logPath } = opts;
  const snap = truncateTail(acc, { maxBytes: PREVIEW_MAX_BYTES, maxLines: PREVIEW_MAX_LINES });
  if (!snap.truncated) return { text: snap.content || emptyText };
  const s = snap.totalLines - snap.outputLines + 1,
    e = snap.totalLines;
  let text = snap.content + `\n\n[L${s}-${e}/${snap.totalLines}`;
  if (snap.lastLinePartial) {
    const lastNl = acc.lastIndexOf("\n");
    text += ` (${fmtSize(snap.outputBytes)} tail, L=${fmtSize(Buffer.byteLength(lastNl === -1 ? acc : acc.slice(lastNl + 1), "utf-8"))})`;
  } else if (snap.truncatedBy === "bytes") {
    text += ` (${fmtSize(PREVIEW_MAX_BYTES)} cap)`;
  }
  let full: string | undefined;
  if (persistIfTruncated) {
    full = logPath ?? join(tmpdir(), `pi-sh-output-${Date.now()}.log`);
    if (!logPath) await writeFile(full, acc);
    text += ` full: ${full}`;
  }
  return { text: text + "]", fullOutputPath: full };
}

export async function runShell(
  command: string,
  waitforSec: number,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  onPartial?: (t: string) => void,
  describe?: string,
  maxWaitfor = 30,
): Promise<ShResult> {
  const child = spawn(existsSync("/bin/bash") ? "/bin/bash" : "bash", ["-c", command], {
    detached: true,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pid = child.pid ?? -1,
    id = String(pid);
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
    exitCode: null,
    done: false,
    bytesEmitted: 0,
    linesEmitted: 0,
    colBytes: 0,
  };

  let lastUpd = 0;
  const onChunk = (chunk: Buffer) => {
    logStream.write(chunk);
    entry.bytesEmitted += chunk.length;
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) entry.colBytes += chunk.length;
    else {
      entry.linesEmitted += chunk.slice(0, lastNl).filter((b) => b === 0x0a).length + 1;
      entry.colBytes = chunk.length - 1 - lastNl;
    }
    entry.acc += chunk.toString("utf8");
    const blen = Buffer.byteLength(entry.acc);
    if (blen > MAX_ACC)
      entry.acc = Buffer.from(entry.acc, "utf8")
        .subarray(blen - MAX_ACC)
        .toString("utf8");
    const now = Date.now();
    if (onPartial && now - lastUpd >= UPDATE_MS) {
      lastUpd = now;
      void buildOutputText(entry.acc, { persistIfTruncated: false }).then((r) => onPartial(r.text));
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);

  const exitP = new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (!entry.done) {
        entry.done = true;
        entry.exitCode = code;
        entry.logStream.end();
        if (bg.has(id)) {
          if (!entry.signaled) completionHook?.(id, command, code, "completed", { path: logPath });
          bg.delete(id);
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
    if (pid > 0)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
  };
  signal?.addEventListener("abort", onAbort);

  let timer: ReturnType<typeof setTimeout>;
  const done = await Promise.race([
    exitP.then(() => true),
    new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), Math.min(waitforSec, maxWaitfor) * 1000);
    }),
  ]);
  signal?.removeEventListener("abort", onAbort);
  clearTimeout(timer!);

  if (done || entry.done) {
    const { text, fullOutputPath } = await buildOutputText(entry.acc, { logPath });
    if (!fullOutputPath) await rm(logPath, { force: true }).catch(() => {});
    return { id: null, status: "completed", exitCode: entry.exitCode, text, fullOutputPath };
  }
  bg.set(id, entry);
  const { text } = await buildOutputText(entry.acc, { logPath });
  return {
    id,
    status: "running",
    exitCode: null,
    text,
    fullOutputPath: logPath,
    cursor: { line: entry.linesEmitted + 1, column: entry.colBytes, bytes: entry.bytesEmitted },
  };
}

export function signalChild(id: string, signal: string): boolean {
  if (id.startsWith("rpt-")) return signalRepeat(id, signal);
  const e = bg.get(id);
  if (!e || e.done) return false;
  try {
    process.kill(-e.pid, /^\d+$/.test(signal) ? Number(signal) : (signal as NodeJS.Signals));
  } catch {
    return false;
  }
  return true;
}

export const silenceChild = (id: string): boolean => {
  const e = bg.get(id);
  if (!e || e.done) return false;
  e.signaled = true;
  return true;
};

export const getBackgroundCount = (): number => bg.size;
export const hasActiveBackground = (): boolean => bg.size > 0 || hasActiveRepeats();

export const getShellBackgrounds = () =>
  [...bg.values()].map((e) => ({ id: e.id, describe: e.describe }));

export const getActiveBackgrounds = () => [
  ...[...bg.values()].map((e) => ({ id: e.id, describe: e.describe })),
  ...getActiveRepeats(),
];

export function killAll(): void {
  for (const e of bg.values()) {
    if (e.done) continue;
    e.done = true;
    try {
      process.kill(-e.pid, "SIGKILL");
    } catch {}
    e.logStream.end();
  }
  bg.clear();
  killAllRepeats();
}
