/**
 * cpi shell extension: `sh`, `sh_signal`, and `sh_repeat_until`.
 *
 * Wraps bash execution with linting (shuck), AST rule checks, TUI rendering,
 * and async completion notifications.
 */

import { Type } from "typebox";
import { renderShCall, renderShResult } from "./shell/render.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadShellConfig } from "./lib/config.ts";
import { checkShellPoll } from "./lib/poll-guard.ts";
import {
  sendNotification,
  type NotificationKind,
} from "./lib/notification.ts";
import { registerHoldSource, signalHoldEvent } from "./lib/session-hold.ts";
import {
  ensureShellTools,
  buildShellEnvWithDotenv,
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
  type OutputTruncation,
} from "./shell/exec.ts";
import { createRepeatTool, getActiveRepeats } from "./shell/repeat.ts";
import { registerShellTranscriptRenderers } from "./shell/transcript.ts";
import { createShellStatusRefresher, type ShellStatusRefresher } from "./shell/status.ts";
import { lintCommand, formatDiagnostics } from "./shell/lint.ts";
import { parseCommand } from "./lib/tree-sitter.ts";
import { checkRules, formatRuleMatches } from "./shell/rules.ts";
import { surfaceCdAgents } from "./shell/cd-targets.ts";
import { runLspHook } from "./shell/lsp-hook.ts";
import { formatAgentsBlock } from "./lib/agents.ts";
import { loadText, render, textPath } from "./lib/text.ts";
const SH_TOOL = "sh",
  SH_SIGNAL_TOOL = "sh_signal",
  SH_REPEAT_TOOL = "sh_repeat_until",
  SH_BACKGROUND_PS_TOOL = "sh_background_ps";
interface ShellText {
  sh: { description: string; prompt_snippet: string };
  sh_signal: { description: string; prompt_snippet: string };
  sh_background_ps: { description: string; prompt_snippet: string };
  guidelines: { sh: string; sh_signal: string; sh_background_ps: string };
  schema: { sh: Record<string, string>; sh_signal: Record<string, string> };
}
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
const fmtDiags = (diags: any[], fmt: (d: any[]) => string) => (diags.length ? fmt(diags) : "");
const errReturn = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
let shellStatus: ShellStatusRefresher | null = null;
// Last command that reached execute (post schema-validation); `!!` replays it.
let lastShCommand: string | null = null;

function disableBuiltinBash(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  const all = pi.getAllTools();
  const withoutBash = active.filter((name) => {
    const tool = all.find((t) => t.name === name && t.sourceInfo?.source === "builtin");
    return tool?.name !== "bash";
  });
  if (withoutBash.length !== active.length) {
    pi.setActiveTools(withoutBash);
  }
}


export default async function (pi: ExtensionAPI) {
  const cfg = loadShellConfig();
  const {
    defaultWaitfor: DEFAULT_WAITFOR,
    maxWaitfor: MAX_WAITFOR,
    maxPreviewLines: MAX_PREVIEW_LINES,
    tailLines: TAIL_LINES,
    describeMax: DESCRIBE_MAX,
  } = cfg;
  const truncateDescribe = (t: string) =>
    t.length <= DESCRIBE_MAX ? t : t.slice(0, DESCRIBE_MAX - 1) + "…";
  const tunables = {
    previewMaxBytes: cfg.previewMaxBytes,
    maxAcc: cfg.maxAcc,
    updateMs: cfg.updateMs,
  };

  const availability = await ensureShellTools().catch(
    () => ({ fd: false, rg: false, shuck: false, treeSitter: false }) as ToolAvailability,
  );
  setCompletionHook((id, cmd, code, reason, log) => {
    signalHoldEvent();
    const isRepeat = id.startsWith("rpt-");
    const kind: NotificationKind = isRepeat
      ? reason === "breach"
        ? "repeat-breach"
        : "repeat-stopped"
      : code === 0
        ? "shell-complete"
        : "shell-failed";
    const base = isRepeat
      ? reason === "breach"
        ? `Repeat monitor ${id} breached on exit ${code ?? "unknown"} (shell command time exceeded repeat interval)`
        : `Repeat monitor ${id} stopped on exit ${code ?? "unknown"}`
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
    sendNotification(pi, { kind, summary, payload }, { deliverAs: "steer" });
  });

  const T = loadText<ShellText>("shell", textPath("shell"));
  const switches = {
    max_waitfor: MAX_WAITFOR,
    max_preview_lines: MAX_PREVIEW_LINES,
    fd: availability.fd,
    rg: availability.rg,
    shuck: availability.shuck,
    tree_sitter: availability.treeSitter,
  };
  const commonGuidelines = render(T.guidelines.sh, switches).split("\n");

  const shSchema = Type.Object({
    description: Type.String({ description: T.schema.sh.description }),
    waitfor: Type.Optional(
      Type.Number({ description: render(T.schema.sh.waitfor, switches) }),
    ),
    head: Type.Optional(
      Type.Number({ description: render(T.schema.sh.head, switches) }),
    ),
    tail: Type.Optional(
      Type.Number({ description: render(T.schema.sh.tail, switches) }),
    ),
    command: Type.String({ description: T.schema.sh.command }),
    env: Type.Optional(Type.String({ description: T.schema.sh.env })),
  });

  pi.registerTool({
    name: SH_TOOL,
    label: "sh",
    description: render(T.sh.description, switches),
    promptSnippet: T.sh.prompt_snippet,
    promptGuidelines: commonGuidelines,
    parameters: shSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (signal?.aborted)
        return { content: [{ type: "text", text: "Aborted before start." }], isError: true };
      if (params.command === "!!") {
        if (lastShCommand === null)
          return errReturn("No previous command to replay (!!): this is the first sh call in the session.");
        params.command = lastShCommand;
      }
      lastShCommand = params.command;
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
      if (params.head !== undefined && params.tail !== undefined)
        return errReturn("head and tail are mutually exclusive; pass at most one.");
      if (
        params.head !== undefined &&
        (!Number.isInteger(params.head) || params.head < 1 || params.head > MAX_PREVIEW_LINES)
      )
        return errReturn(
          `head must be an integer in 1..${MAX_PREVIEW_LINES} (got ${params.head}).`,
        );
      if (
        params.tail !== undefined &&
        (!Number.isInteger(params.tail) || params.tail < 1 || params.tail > MAX_PREVIEW_LINES)
      )
        return errReturn(
          `tail must be an integer in 1..${MAX_PREVIEW_LINES} (got ${params.tail}).`,
        );
      const truncation: OutputTruncation =
        params.head !== undefined
          ? { mode: "head", maxLines: params.head }
          : { mode: "tail", maxLines: params.tail ?? MAX_PREVIEW_LINES };
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

      const describe = params.description?.trim();
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
          truncation: { mode: "tail", maxLines: MAX_PREVIEW_LINES },
          tunables,
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
      const cdAgents = surfaceCdAgents(parse.node);
      const slowDown = checkShellPoll(params.command);

      onUpdate?.({ content: [], details: undefined });
      const res = await runShell(
        params.command,
        effectiveWaitfor,
        buildShellEnvWithDotenv(ctx?.sessionManager, params.env),
        signal,
        (t) => onUpdate?.({ content: [{ type: "text", text: t }], details: undefined }),
        describe,
        MAX_WAITFOR,
        truncation,
        tunables,
      );

      const tag = describe ? ` (${truncateDescribe(describe)})` : "";
      const status =
        res.status === "running"
          ? `running PID=${res.id}${tag}${res.cursor ? ` | ${res.cursor.bytes}B at L${res.cursor.line}:${res.cursor.column} -> ${res.fullOutputPath}` : ""}`
          : `exit ${res.exitCode ?? "unknown"}${tag}`;
      let text = res.text ? `${res.text}\n---\n${status}` : status;
      if (shuckWarnings) text = `linter warnings:\n${shuckWarnings}\n---\n${text}`;
      if (slowDown) text = `${slowDown}\n---\n${text}`;
      text += formatAgentsBlock(cdAgents);
      text += await runLspHook(availability.treeSitter ? parse.node : null);

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
          cdAgentsFiles: cdAgents.map((f) => f.path),
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
    name: SH_SIGNAL_TOOL,
    label: "sh_signal",
    description: render(T.sh_signal.description, switches),
    promptSnippet: T.sh_signal.prompt_snippet,
    promptGuidelines: render(T.guidelines.sh_signal, switches).split("\n"),
    parameters: Type.Object({
      id: Type.String({ description: T.schema.sh_signal.id }),
      signal: Type.Optional(
        Type.String({ description: T.schema.sh_signal.signal }),
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

  pi.registerTool(
    createRepeatTool(pi, DEFAULT_WAITFOR, MAX_WAITFOR, TAIL_LINES, DESCRIBE_MAX, availability),
  );
  registerShellTranscriptRenderers();

  pi.registerTool({
    name: SH_BACKGROUND_PS_TOOL,
    label: "sh_background_ps",
    description: render(T.sh_background_ps.description, switches),
    promptSnippet: T.sh_background_ps.prompt_snippet,
    promptGuidelines: render(T.guidelines.sh_background_ps, switches).split("\n"),
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
    shellStatus?.dispose();
    shellStatus = createShellStatusRefresher(ctx);
    pi.setActiveTools(
      Array.from(
        new Set([
          ...pi.getActiveTools().filter((n) => n !== "bash"),
          SH_TOOL,
          SH_SIGNAL_TOOL,
          SH_REPEAT_TOOL,
          SH_BACKGROUND_PS_TOOL,
        ]),
      ),
    );
  });

  pi.on("resources_discover", async () => disableBuiltinBash(pi));

  registerHoldSource({
    id: "shell",
    hasPending: () => hasActiveBackground(),
    noticeText: () =>
      `active background shells: ${getActiveBackgrounds()
        .map((b) => `[${b.id}${b.describe ? " " + truncateDescribe(b.describe) : ""}]`)
        .join(", ")}`,
    deadlineMs: 5 * 60 * 1000,
    onAbort: killAll,
  });

  pi.on("session_shutdown", async () => {
    shellStatus?.dispose();
    shellStatus = null;
  });
}
