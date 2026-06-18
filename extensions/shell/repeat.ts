/**
 * Repeat-until monitor engine and tool factory.
 *
 * The engine is a Node-side loop: each iteration spawns `bash -c command`
 * detached and arms a per-iteration timeout equal to the interval. If the
 * timeout fires first, the invocation breached the contract and the whole
 * monitor is stopped.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderShCall, renderShResult } from "./render.ts";
import { getShuckBinPath, getToolEnv, type ToolAvailability } from "./tools.ts";
import { lintCommand, formatDiagnostics } from "./lint.ts";
import { parseCommand } from "./parse.ts";
import { checkRules, formatRuleMatches } from "./rules.ts";

const MAX_ACC = 4 * 1024 * 1024;

export type RepeatCompletionHook = (
  id: string,
  cmd: string,
  code: number | null,
  reason: "completed" | "triggered" | "breach",
) => void;

interface RepeatMonitor {
  id: string;
  command: string;
  describe?: string;
  intervalSec: number;
  triggerCode: number;
  env: NodeJS.ProcessEnv;
  running: boolean;
  breached: boolean;
  child?: ChildProcess;
  pid: number;
  timeout?: ReturnType<typeof setTimeout>;
  nextTimer?: ReturnType<typeof setTimeout>;
  acc: string;
}

const rpt = new Map<string, RepeatMonitor>();
let rptCounter = 0;
let hook: RepeatCompletionHook | undefined;

export const setRepeatCompletionHook = (fn: RepeatCompletionHook) => {
  hook = fn;
};

function boundAcc(mon: RepeatMonitor, chunk: Buffer): void {
  mon.acc += chunk.toString("utf8");
  const blen = Buffer.byteLength(mon.acc);
  if (blen > MAX_ACC)
    mon.acc = Buffer.from(mon.acc, "utf8")
      .subarray(blen - MAX_ACC)
      .toString("utf8");
}

function stopRepeat(mon: RepeatMonitor, notify = false): void {
  if (!mon.running && !notify) return;
  mon.running = false;
  clearTimeout(mon.timeout);
  clearTimeout(mon.nextTimer);
  if (mon.child && !mon.child.killed && mon.pid > 0) {
    try {
      process.kill(-mon.pid, "SIGTERM");
    } catch {}
  }
  if (notify) {
    hook?.(mon.id, mon.command, null, "breach");
    rpt.delete(mon.id);
  }
}

function finishRepeat(
  mon: RepeatMonitor,
  code: number | null,
  reason: "completed" | "triggered",
): void {
  mon.running = false;
  clearTimeout(mon.timeout);
  hook?.(mon.id, mon.command, code, reason);
  rpt.delete(mon.id);
}

function scheduleNext(mon: RepeatMonitor): void {
  if (!mon.running) return;
  mon.nextTimer = setTimeout(() => runIteration(mon), mon.intervalSec * 1000);
}

function runIteration(mon: RepeatMonitor): void {
  if (!mon.running || mon.breached) return;
  clearTimeout(mon.nextTimer);
  const child = spawn(existsSync("/bin/bash") ? "/bin/bash" : "bash", ["-c", mon.command], {
    detached: true,
    env: mon.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  mon.child = child;
  mon.pid = child.pid ?? -1;

  child.stdout?.on("data", (chunk: Buffer) => boundAcc(mon, chunk));
  child.stderr?.on("data", (chunk: Buffer) => boundAcc(mon, chunk));

  mon.timeout = setTimeout(() => {
    mon.breached = true;
    stopRepeat(mon, true);
  }, mon.intervalSec * 1000);

  child.on("exit", (code) => {
    clearTimeout(mon.timeout);
    if (mon.breached) {
      rpt.delete(mon.id);
      return;
    }
    if (!mon.running) return;
    if (code === mon.triggerCode) {
      finishRepeat(mon, code, "triggered");
      return;
    }
    if (code !== 0) {
      finishRepeat(mon, code, "completed");
      return;
    }
    scheduleNext(mon);
  });

  child.on("error", () => {
    clearTimeout(mon.timeout);
    if (!mon.running || mon.breached) return;
    finishRepeat(mon, null, "completed");
  });
}

export function startRepeat(
  command: string,
  intervalSec: number,
  triggerCode: number,
  env: NodeJS.ProcessEnv,
  describe?: string,
): string {
  const id = `rpt-${++rptCounter}`;
  const mon: RepeatMonitor = {
    id,
    command,
    describe,
    intervalSec,
    triggerCode,
    env,
    running: true,
    breached: false,
    pid: -1,
    acc: "",
  };
  rpt.set(id, mon);
  runIteration(mon);
  return id;
}

export function signalRepeat(id: string, signal: string): boolean {
  const mon = rpt.get(id);
  if (!mon) return false;
  stopRepeat(mon, false);
  if (mon.child && mon.pid > 0) {
    try {
      process.kill(-mon.pid, /^\d+$/.test(signal) ? Number(signal) : (signal as NodeJS.Signals));
    } catch {}
  }
  rpt.delete(id);
  return true;
}

export const getRepeatCount = (): number => rpt.size;
export const hasActiveRepeats = (): boolean => rpt.size > 0;
export const getActiveRepeats = () =>
  [...rpt.values()].map((e) => ({ id: e.id, describe: e.describe }));

export function killAllRepeats(): void {
  for (const mon of rpt.values()) stopRepeat(mon, false);
  rpt.clear();
}

const fmtDiags = (diags: any[], fmt: (d: any[]) => string) => (diags.length ? fmt(diags) : "");

// ── Tool factory ───────────────────────────────────────────────────────────────

const truncateDescribe = (t: string, max = 48) => (t.length <= max ? t : t.slice(0, max - 1) + "…");

export function createRepeatTool(
  pi: ExtensionAPI,
  DEFAULT_WAITFOR: number,
  MAX_WAITFOR: number,
  TAIL_LINES: number,
  availability: ToolAvailability,
) {
  const schema = Type.Object({
    command: Type.String({ description: "Command to run repeatedly" }),
    interval: Type.Number({
      minimum: 5,
      maximum: 60,
      description: "Seconds between repetitions (5-60)",
    }),
    trigger_code: Type.Optional(
      Type.Number({
        description:
          "Exit code that stops repetition and triggers success notification (default 0)",
      }),
    ),
    describe: Type.Optional(
      Type.String({ description: "Short description of what this monitor is doing (a few words)" }),
    ),
  });

  const guidelines = [
    "Use sh_repeat_until for active polling, not for passive waits; prefer the `alarm` tool for simple delayed wake-ups.",
    "sh_repeat_until interval must be between 5 and 60 seconds.",
    "If a sh_repeat_until invocation takes longer than its interval, the monitor stops and emits a repeat-breach notification.",
    "For sh_repeat_until, trigger_code (default 0) is the exit code that stops repetition and emits a repeat-triggered success notification.",
    "For sh_repeat_until, any non-zero exit code that does not match trigger_code stops repetition and emits a shell-complete error notification.",
    "Cancel a repeat monitor with sh_send_signal using its rpt- ID; SIGKILL terminates immediately.",
  ];

  return {
    name: "sh_repeat_until",
    label: "sh_repeat_until",
    description:
      "Run a command repeatedly until it exits with trigger_code. Stateless, detached process group. Backgrounded by default.",
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
      const triggerCode = params.trigger_code ?? 0;
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
        ? `⚠ shuck warnings:\n${warnParts.join("\n")}\n---\n`
        : "";

      const id = startRepeat(params.command, interval, triggerCode, getToolEnv(), describe);
      const status = `repeating PID=${id} every ${interval}s · trigger on code ${triggerCode}`;
      const tag = describe ? ` (${truncateDescribe(describe)})` : "";
      return {
        content: [{ type: "text", text: `${warningPrefix}${status}${tag}` }],
        details: {
          id,
          status: "repeating",
          interval,
          triggerCode,
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
