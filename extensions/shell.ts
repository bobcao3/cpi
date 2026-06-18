/**
 * cpi shell extension: `sh`, `sh_send_signal`, and `sh_repeat_until`.
 *
 * Wraps bash execution with linting (shuck), AST rule checks, TUI rendering,
 * and async completion notifications.
 */

import { Type } from "typebox";
import { renderShCall, renderShResult } from "./shell/render.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadShellConfig } from "./lib/config.ts";
import {
  registerNotificationRenderer,
  sendNotification,
  type NotificationKind,
} from "./lib/notification.ts";
import {
  ensureShellTools,
  getToolEnv,
  getShuckBinPath,
  type ToolAvailability,
} from "./shell/tools.ts";
import {
  buildOutputText,
  getActiveBackgrounds,
  getShellBackgrounds,
  hasActiveBackground,
  killAll,
  runShell,
  setCompletionHook,
  signalChild,
  silenceChild,
} from "./shell/exec.ts";
import { createRepeatTool, getActiveRepeats } from "./shell/repeat.ts";
import { setupFooter } from "./shell/footer.ts";
import { lintCommand, formatDiagnostics, disposeLspClient } from "./shell/lint.ts";
import { parseCommand } from "./shell/parse.ts";
import { checkRules, formatRuleMatches } from "./shell/rules.ts";

const SH_TOOL = "sh",
  SH_SEND_SIGNAL_TOOL = "sh_send_signal",
  SH_REPEAT_TOOL = "sh_repeat_until",
  SH_BACKGROUND_PS_TOOL = "sh_background_ps",
  TAIL_LINES = 5;
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const truncateDescribe = (t: string, max = 48) => (t.length <= max ? t : t.slice(0, max - 1) + "…");
const fmtDiags = (diags: any[], fmt: (d: any[]) => string) => (diags.length ? fmt(diags) : "");
let holdNoticeSent = false,
  lastStopReason: string | undefined;

export default async function (pi: ExtensionAPI) {
  const { defaultWaitfor: DEFAULT_WAITFOR, maxWaitfor: MAX_WAITFOR } = loadShellConfig();

  const shSchema = Type.Object({
    command: Type.String({ description: "Command to run" }),
    waitfor: Type.Optional(
      Type.Number({
        description: `Seconds to wait before backgrounding (default ${DEFAULT_WAITFOR}, max ${MAX_WAITFOR}; >${MAX_WAITFOR} errors)`,
      }),
    ),
    describe: Type.Optional(
      Type.String({ description: "Short description of what this command is doing (a few words)" }),
    ),
  });

  const availability = await ensureShellTools().catch(
    () => ({ fd: false, rg: false, shuck: false, treeSitter: false }) as ToolAvailability,
  );
  registerNotificationRenderer(pi);
  setCompletionHook((id, _cmd, code, reason, log) => {
    const isRepeat = id.startsWith("rpt-");
    const kind: NotificationKind =
      reason === "triggered"
        ? "repeat-triggered"
        : reason === "breach"
          ? "repeat-breach"
          : isRepeat
            ? "repeat-command-failed"
            : code === 0
              ? "shell-complete"
              : "shell-failed";
    const base = isRepeat
      ? reason === "triggered"
        ? `Repeat monitor ${id} triggered on exit ${code}`
        : reason === "breach"
          ? `Repeat monitor ${id} breached on exit ${code ?? "unknown"} (shell command time exceeded repeat interval)`
          : `Repeat monitor ${id} command failed on exit ${code ?? "unknown"}`
      : code === 0
        ? `Shell ${id} completed on exit ${code}`
        : `Shell ${id} command failed on exit ${code ?? "unknown"}`;
    const hasRange = log && log.startLine !== undefined && log.endLine !== undefined;
    const summary = log
      ? `${base}; log ${log.path}${hasRange ? ` lines ${log.startLine}..${log.endLine}` : ""}`
      : base;
    const payload: Record<string, unknown> = {
      "shell-id": id,
      "exit-code": code ?? -1,
      summary,
    };
    sendNotification(pi, { kind, summary, payload }, { deliverAs: "followUp" });
  });

  const commonGuidelines = [
    "Each sh call = fresh `bash -c`. No session reuse; env/cwd/shell state don't persist.",
    "For sh and sh_repeat_until, always pass a short `describe` parameter (a few words) explaining the command's purpose.",
    `Keep waitfor <=${MAX_WAITFOR}s. On overflow, sh returns PID + partial output.`,
    "Signal a bg shell via sh_send_signal with its PID; send SIGKILL to terminate.",
    "You will receive a notification once a background shell completes, feel free to relinquish control if you need to wait.",
    "Do not set alarm for 'checking on backgrounded shell', you will be waken up once background notifies",
    "Avoid polling, but if you really have to, use the `alarm` tool instead of a long `sleep &&` command.",
    "If a background shell completes and you decide no follow up needed, say 'ACK' exactly.",
    ...(availability.fd
      ? ["Search files with `$ fd` not `$ find`: fd [OPTS] [-H] [-I] [pattern] [path]..."]
      : []),
    ...(availability.rg
      ? [
          "Search content with `$ rg` not `$ grep`: rg [OPTS] [--hidden] [--no-ignore] PATTERN [path]...",
        ]
      : []),
    ...(availability.shuck
      ? [
          "Every `sh` command is auto-linted by shuck before execution. Errors block; fix and retry. Warnings surface to you only.",
        ]
      : []),
  ];

  pi.registerTool({
    name: SH_TOOL,
    label: "sh",
    description:
      "Run a command via `bash -c`. Stateless: no env/cwd persistence. Outliving waitfor backgrounds it and returns an id for signalling. Maximum waitfor is " +
      MAX_WAITFOR +
      "s.",
    promptSnippet: "Run shell commands",
    promptGuidelines: commonGuidelines,
    parameters: shSchema,
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted)
        return { content: [{ type: "text", text: "Aborted before start." }], isError: true };
      if (params.waitfor !== undefined && params.waitfor > MAX_WAITFOR)
        return {
          content: [
            {
              type: "text",
              text: `waitfor must be <= ${MAX_WAITFOR}s (got ${params.waitfor}). For longer waits, background and use alarm.`,
            },
          ],
          isError: true,
        };
      const effectiveWaitfor = params.waitfor ?? DEFAULT_WAITFOR;
      // Inline sleep guard
      const sleepMatch = [
        ...params.command.matchAll(/(?:^|\s)sleep\s+(\d+(?:\.\d+)?)\s*([smhd])?\s*&&/g),
      ]
        .map((m) => parseFloat(m[1]) * (m[2] ? SLEEP_UNITS[m[2]] : 1))
        .find((sec) => sec > effectiveWaitfor);
      if (sleepMatch !== undefined)
        return {
          content: [
            {
              type: "text",
              text: `Blocked: 'sleep ${sleepMatch}s && ...' exceeds waitfor (${effectiveWaitfor}s). Background and use alarm.`,
            },
          ],
          isError: true,
        };

      const describe = params.describe?.trim();
      const shuckPath = availability.shuck ? getShuckBinPath() : null;
      const [lint, parse] = await Promise.all([
        shuckPath
          ? lintCommand(params.command, shuckPath)
          : Promise.resolve({ errors: [], warnings: [], available: false }),
        availability.treeSitter
          ? parseCommand(params.command)
          : Promise.resolve({ ast: null, available: false, node: null }),
      ]);
      const ruleResult = parse.node
        ? checkRules(parse.node, { fdAvailable: availability.fd, rgAvailable: availability.rg })
        : { rejections: [], warnings: [] };

      const errParts = [
        fmtDiags(lint.errors, formatDiagnostics),
        fmtDiags(ruleResult.rejections, formatRuleMatches),
      ].filter(Boolean);
      if (errParts.length) {
        const { text, fullOutputPath } = await buildOutputText(errParts.join("\n"), {
          persistIfTruncated: true,
          emptyText: "(no detail)",
        });
        const count = (lint.available ? lint.errors.length : 0) + ruleResult.rejections.length;
        return {
          content: [
            {
              type: "text",
              text: `${text}\n---\nblocked (${count} error${count !== 1 ? "s" : ""})`,
            },
          ],
          details: { fullOutputPath, describe, shuckBlocked: true, tsAst: parse.ast },
          isError: true,
        };
      }

      const warnParts = [
        fmtDiags(lint.warnings, formatDiagnostics),
        fmtDiags(ruleResult.warnings, formatRuleMatches),
      ].filter(Boolean);
      const shuckWarnings = warnParts.length ? warnParts.join("\n") : undefined;

      onUpdate?.({ content: [], details: undefined });
      const res = await runShell(
        params.command,
        effectiveWaitfor,
        getToolEnv(),
        signal,
        (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: undefined }),
        describe,
        MAX_WAITFOR,
      );

      const tag = describe ? ` (${truncateDescribe(describe)})` : "";
      const status =
        res.status === "running"
          ? `running PID=${res.id}${tag}${res.cursor ? ` | ${res.cursor.bytes}B at L${res.cursor.line}:${res.cursor.column} -> ${res.fullOutputPath}` : ""}`
          : `exit ${res.exitCode ?? "unknown"}${tag}`;
      let text = res.text ? `${res.text}\n---\n${status}` : status;
      if (shuckWarnings) text = `⚠ shuck warnings:\n${shuckWarnings}\n---\n${text}`;

      return {
        content: [{ type: "text", text }],
        details: {
          id: res.id,
          exitCode: res.exitCode,
          status: res.status,
          fullOutputPath: res.fullOutputPath,
          cursor: res.cursor,
          describe,
          shuckWarnings,
          tsAst: parse.ast,
        },
        isError: res.status === "completed" && res.exitCode !== 0 && res.exitCode !== null,
      };
    },
    renderCall(args, theme, context) {
      return renderShCall(args, theme, context, DEFAULT_WAITFOR, TAIL_LINES);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      return renderShResult(result, { expanded, isPartial }, theme, TAIL_LINES);
    },
  });

  pi.registerTool({
    name: SH_SEND_SIGNAL_TOOL,
    label: "sh_send_signal",
    description:
      "Signal a background shell command by its PID (sh-returned). Send SIGKILL to terminate background shell process-group.",
    promptSnippet: "Signal background shell commands",
    promptGuidelines: [
      "sh_send_signal defaults to SIGINT, delivered to the whole process group.",
      "Avoid using `sh $ kill` against background shell PIDs, use `sh_send_signal` instead.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Background shell PID (as returned by sh)" }),
      signal: Type.Optional(
        Type.String({ description: "Signal name/number (default SIGINT; SIGKILL to terminate)" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const signal = params.signal ?? "SIGINT";
      if (!signalChild(params.id, signal))
        return {
          content: [{ type: "text", text: `Background ${params.id} not active.` }],
          isError: true,
        };
      if (!params.id.startsWith("rpt-")) silenceChild(params.id);
      return {
        content: [{ type: "text", text: `Sent ${signal} to ${params.id}.` }],
        details: { id: params.id, signal, completionNoticeSuppressed: true },
      };
    },
  });

  pi.registerTool(createRepeatTool(pi, DEFAULT_WAITFOR, MAX_WAITFOR, TAIL_LINES, availability));

  pi.registerTool({
    name: SH_BACKGROUND_PS_TOOL,
    label: "sh_background_ps",
    description: "List active background shells and repeat_until monitors.",
    promptSnippet: "List active background jobs",
    promptGuidelines: ["Use sh_background_ps to check running background shells and monitors."],
    parameters: Type.Object({}),
    async execute() {
      const bgs = getShellBackgrounds();
      const rpts = getActiveRepeats();
      const total = bgs.length + rpts.length;
      if (total === 0) {
        return {
          content: [{ type: "text", text: "no active background shells or monitors" }],
          isError: false,
        };
      }
      const parts: string[] = [];
      if (bgs.length) parts.push(`${bgs.length} bg shell${bgs.length !== 1 ? "s" : ""}`);
      if (rpts.length) parts.push(`${rpts.length} monitor${rpts.length !== 1 ? "s" : ""}`);
      const entries = [...bgs, ...rpts]
        .map((e) => `[${e.id}${e.describe ? " " + truncateDescribe(e.describe) : ""}]`)
        .join(" ");
      return {
        content: [{ type: "text", text: `${parts.join(", ")}: ${entries}` }],
        details: { backgrounds: bgs, repeats: rpts },
        isError: false,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    setupFooter(pi, ctx);
    pi.setActiveTools(
      Array.from(
        new Set([
          ...pi.getActiveTools().filter((n) => n !== "bash"),
          SH_TOOL,
          SH_SEND_SIGNAL_TOOL,
          SH_REPEAT_TOOL,
          SH_BACKGROUND_PS_TOOL,
        ]),
      ),
    );
  });

  const emitHold = (ctx: ExtensionContext) => {
    const parts = getActiveBackgrounds().map(
      (b) => `[${b.id}${b.describe ? " " + truncateDescribe(b.describe) : ""}]`,
    );
    const text = `active background shells: ${parts.join(", ")}`;
    process.stderr.write(`[shell-hold] ${text}\n`);
    ctx.hasUI && ctx.ui.notify(text, "info");
  };

  pi.on("agent_start", () => {
    lastStopReason = undefined;
    holdNoticeSent = false;
  });

  pi.on("agent_end", (event, ctx) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      if (event.messages[i].role === "assistant") {
        lastStopReason = (event.messages[i] as any).stopReason;
        break;
      }
    }
    if (
      ctx.hasUI ||
      lastStopReason === "error" ||
      lastStopReason === "aborted" ||
      !hasActiveBackground()
    )
      return;
    if (!holdNoticeSent) {
      emitHold(ctx);
      holdNoticeSent = true;
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    disposeLspClient();
    if (
      ctx.hasUI ||
      event.reason !== "quit" ||
      !hasActiveBackground() ||
      lastStopReason === "error" ||
      lastStopReason === "aborted"
    ) {
      killAll();
      return;
    }
    if (!holdNoticeSent) {
      emitHold(ctx);
      holdNoticeSent = true;
    }
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!hasActiveBackground() && ctx.isIdle())
          setTimeout(
            () => (!hasActiveBackground() && ctx.isIdle() ? resolve() : setTimeout(check, 100)),
            500,
          );
        else setTimeout(check, 100);
      };
      check();
    });
    killAll();
  });
}
