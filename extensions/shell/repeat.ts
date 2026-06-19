/**
 * Repeat-until monitor engine and tool factory.
 *
 * Each monitor appends every invocation to a single log file. Invocations are
 * separated by header/footer blocks so the agent can locate a failed run by
 * line range.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderShCall, renderShResult } from "./render.ts";
import { getShuckBinPath, getToolEnv, type ToolAvailability } from "./tools.ts";
import { lintCommand, formatDiagnostics } from "./lint.ts";
import { parseCommand } from "./parse.ts";
import { checkRules, formatRuleMatches } from "./rules.ts";

export interface RepeatLogRange {
  path: string;
  startLine?: number;
  endLine?: number;
}

export type RepeatCompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "stopped" | "breach",
  log?: RepeatLogRange,
) => void;

interface RepeatMonitor {
  id: string;
  command: string;
  describe?: string;
  intervalSec: number;
  env: NodeJS.ProcessEnv;
  running: boolean;
  breached: boolean;
  child?: ChildProcess;
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  nextTimer?: ReturnType<typeof setTimeout>;
  logPath: string;
  logStream: WriteStream;
  logLine: number;
  invocation: number;
  startLine?: number;
}

const rpt = new Map<string, RepeatMonitor>();
let rptCounter = 0;
let hook: RepeatCompletionHook | undefined;

export const setRepeatCompletionHook = (fn: RepeatCompletionHook) => {
  hook = fn;
};

function writeLog(mon: RepeatMonitor, text: string): void {
  if (!text.length) return;
  mon.logStream.write(text);
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") mon.logLine++;
}

function writeLogBuffer(mon: RepeatMonitor, chunk: Buffer): void {
  if (!chunk.length) return;
  mon.logStream.write(chunk);
  for (const b of chunk) if (b === 0x0a) mon.logLine++;
}

function stopRepeat(mon: RepeatMonitor): void {
  if (!mon.running) return;
  mon.running = false;
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  if (mon.child && !mon.child.killed && mon.pid > 0) {
    try {
      process.kill(-mon.pid, "SIGTERM");
    } catch {}
  }
  mon.logStream.end();
}

function finalize(
  mon: RepeatMonitor,
  code: number | null,
  outcome: "stopped" | "breach" | "next",
): void {
  const reason = outcome === "next" ? "continue" : outcome;
  const footer = `───────────────────────────────────────────────────────────────────────────────\nExit: ${code ?? "unknown"} (${reason})\n═══════════════════════════════════════════════════════════════════════════════\n`;
  writeLog(mon, footer);
  if (outcome === "next") {
    scheduleNext(mon);
    return;
  }
  mon.running = false;
  clearTimeout(mon.timeout);
  mon.logStream.end();
  hook?.(mon.id, mon.command, code, outcome, {
    path: mon.logPath,
    startLine: mon.startLine,
    endLine: mon.logLine,
  });
  rpt.delete(mon.id);
}

function scheduleNext(mon: RepeatMonitor): void {
  if (!mon.running) return;
  mon.nextTimer = setTimeout(() => runIteration(mon), mon.intervalSec * 1000);
}

function runIteration(mon: RepeatMonitor): void {
  if (!mon.running || mon.breached) return;
  clearTimeout(mon.nextTimer);
  mon.invocation++;
  mon.startLine = mon.logLine + 1;
  const header = `═══════════════════════════════════════════════════════════════════════════════\nInvocation ${mon.invocation} — ${new Date().toISOString()}\nCommand: ${mon.command}\n───────────────────────────────────────────────────────────────────────────────\n`;
  writeLog(mon, header);

  const child = spawn(existsSync("/bin/bash") ? "/bin/bash" : "bash", ["-c", mon.command], {
    detached: true,
    env: mon.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mon.child = child;
  mon.pid = child.pid ?? -1;

  child.stdout?.on("data", (chunk: Buffer) => writeLogBuffer(mon, chunk));
  child.stderr?.on("data", (chunk: Buffer) => writeLogBuffer(mon, chunk));

  mon.timeout = setTimeout(() => {
    mon.breached = true;
    if (mon.child && !mon.child.killed && mon.pid > 0) {
      try {
        process.kill(-mon.pid, "SIGTERM");
      } catch {}
    }
  }, mon.intervalSec * 1000);

  child.on("close", (code) => {
    clearTimeout(mon.timeout);
    if (!mon.running || mon.breached) {
      if (mon.breached) finalize(mon, null, "breach");
      return;
    }
    if (code === 0) {
      finalize(mon, 0, "next");
      return;
    }
    finalize(mon, code, "stopped");
  });

  child.on("error", () => {
    clearTimeout(mon.timeout);
    if (!mon.running || mon.breached) return;
    finalize(mon, null, "stopped");
  });
}

export function startRepeat(
  command: string,
  intervalSec: number,
  env: NodeJS.ProcessEnv,
  describe?: string,
): string {
  const id = `rpt-${++rptCounter}`;
  const logPath = join(tmpdir(), `pi-rpt-output-${id}-${Date.now()}.log`);
  const logStream = createWriteStream(logPath, { flags: "a" });
  const mon: RepeatMonitor = {
    id,
    command,
    describe,
    intervalSec,
    env,
    running: true,
    breached: false,
    pid: -1,
    logPath,
    logStream,
    logLine: 0,
    invocation: 0,
    startLine: 1,
  };
  rpt.set(id, mon);
  runIteration(mon);
  return id;
}

export function signalRepeat(id: string, signal: string): boolean {
  const mon = rpt.get(id);
  if (!mon) return false;
  stopRepeat(mon);
  if (mon.child && mon.pid > 0) {
    try {
      process.kill(-mon.pid, /^\d+$/.test(signal) ? Number(signal) : (signal as NodeJS.Signals));
    } catch {}
  }
  rpt.delete(mon.id);
  return true;
}

export const getRepeatCount = (): number => rpt.size;
export const hasActiveRepeats = (): boolean => rpt.size > 0;
export const getActiveRepeats = () =>
  [...rpt.values()].map((e) => ({ id: e.id, describe: e.describe }));

export function killAllRepeats(): void {
  for (const mon of rpt.values()) stopRepeat(mon);
  rpt.clear();
}

const fmtDiags = (diags: any[], fmt: (d: any[]) => string) => (diags.length ? fmt(diags) : "");

// ── Tool factory ───────────────────────────────────────────────────────────────

export function createRepeatTool(
  pi: ExtensionAPI,
  DEFAULT_WAITFOR: number,
  MAX_WAITFOR: number,
  TAIL_LINES: number,
  DESCRIBE_MAX: number,
  availability: ToolAvailability,
) {
  const truncateDescribe = (t: string) =>
    t.length <= DESCRIBE_MAX ? t : t.slice(0, DESCRIBE_MAX - 1) + "…";
  const schema = Type.Object({
    command: Type.String({ description: "Command to run repeatedly" }),
    interval: Type.Number({
      minimum: 5,
      maximum: 60,
      description: "Seconds between repetitions (5-60)",
    }),
    describe: Type.String({ description: "Short description of what this monitor is doing (a few words)" }),
  });

  const guidelines = [
    "Use sh_repeat_until for active polling, not for passive waits; prefer the `alarm` tool for simple delayed wake-ups.",
    "sh_repeat_until interval must be between 5 and 60 seconds.",
    "If a sh_repeat_until invocation takes longer than its interval, the monitor stops and emits a repeat-breach notification.",
    "For sh_repeat_until, exit code 0 means the condition is not met yet; keep polling. Any non-zero exit code stops the monitor.",
    "When the monitor stops on a non-zero exit, a single notification is emitted regardless of whether the command succeeded or errored.",
    "The notification includes the monitor log file path and the line range for the stopping invocation.",
    "Cancel a repeat monitor with sh_signal using its rpt- ID; SIGKILL terminates immediately.",
  ];

  return {
    name: "sh_repeat_until",
    label: "sh_repeat_until",
    description:
      "Run a command repeatedly until it exits non-zero; exit code 0 continues looping. Stateless, detached process group. Backgrounded by default.",
    promptSnippet: "Poll with repeated shell commands",
    promptGuidelines: guidelines,
    parameters: schema,
    async execute(
      _toolCallId: string,
      params: any,
      _signal: AbortSignal | undefined,
      _onUpdate: any,
      _ctx: any,
    ) {
      const interval = params.interval;
      const describe = params.describe?.trim();
      if (interval < 5 || interval > 60) {
        return {
          content: [{ type: "text", text: `interval must be 5-60s (got ${interval}).` }],
          isError: true,
        };
      }

      const shuckPath = availability.shuck ? getShuckBinPath() : null;
      const [lint, parsed] = await Promise.all([
        shuckPath
          ? lintCommand(params.command, shuckPath)
          : Promise.resolve({ errors: [], warnings: [], available: false }),
        availability.treeSitter
          ? parseCommand(params.command)
          : Promise.resolve({ ast: null, available: false, node: null }),
      ]);
      const ruleResult = parsed.node
        ? checkRules(parsed.node, { fdAvailable: availability.fd, rgAvailable: availability.rg })
        : { rejections: [], warnings: [] };
      const errParts = [
        fmtDiags(lint.errors, formatDiagnostics),
        fmtDiags(ruleResult.rejections, formatRuleMatches),
      ].filter(Boolean);
      if (errParts.length) {
        const count = (lint.available ? lint.errors.length : 0) + ruleResult.rejections.length;
        return {
          content: [
            {
              type: "text",
              text: `${errParts.join("\n")}\n---\nblocked (${count} error${count !== 1 ? "s" : ""})`,
            },
          ],
          details: { describe, shuckBlocked: true, tsAst: parsed.ast },
          isError: true,
        };
      }
      const warnParts = [
        fmtDiags(lint.warnings, formatDiagnostics),
        fmtDiags(ruleResult.warnings, formatRuleMatches),
      ].filter(Boolean);
      const warningPrefix = warnParts.length
        ? `linter warnings:\n${warnParts.join("\n")}\n---\n`
        : "";

      const id = startRepeat(params.command, interval, getToolEnv(), describe);
      const status = `repeating PID=${id} every ${interval}s · stop on non-zero exit`;
      const tag = describe ? ` (${truncateDescribe(describe)})` : "";
      return {
        content: [{ type: "text", text: `${warningPrefix}${status}${tag}` }],
        details: {
          id,
          status: "repeating",
          interval,
          describe,
          shuckWarnings: warningPrefix || undefined,
          tsAst: parsed.ast,
        },
        isError: false,
      };
    },
    renderCall(args: any, theme: any, context: any) {
      return renderShCall(args, theme, context, DEFAULT_WAITFOR, TAIL_LINES);
    },
    renderResult(
      result: any,
      { expanded, isPartial }: { expanded: boolean; isPartial: boolean },
      theme: any,
    ) {
      return renderShResult(result, { expanded, isPartial }, theme, TAIL_LINES);
    },
  };
}
