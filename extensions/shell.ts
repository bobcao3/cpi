/**
 * cpi shell extension: `sh`, `sh_signal`, and `sh_repeat_until`.
 *
 * Wraps resolved/configured shell execution with linting (shuck), AST rule checks, TUI rendering,
 * and async completion notifications.
 */

import { registerTerminalCaptureTool } from "./shell/terminal-capture.ts";
import { surface_shell_shutdowns } from "./shell/shutdown.ts";
import { Type } from "typebox";
import {
  renderCompactShellCall,
  renderCompactShellResult,
} from "./shell/compact-render.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadShellConfig } from "./lib/config.ts";
import { getCwd } from "./lib/cwd.ts";
import { checkShellPoll } from "./lib/poll-guard.ts";
import { sendNotification, type NotificationKind } from "./lib/notification.ts";
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
  captureSessionScreenshot,
  resumeBackgroundShells,
  setCurrentScope,
  setCompletionHook,
  type OutputTruncation,
} from "./shell/exec.ts";
import { createRepeatTool, resumeRepeats } from "./shell/repeat.ts";
import { suspendRepeatWrites } from "./shell/repeat-persistence.ts";
import {
  bindShellPersistence,
  restoreShellActivities,
  suspendShellWrites,
} from "./shell/persistence.ts";
import { migrateShellRecords } from "./shell/persistence-migration.ts";
import { acknowledgeShellNotifications } from "./shell/completion-delivery.ts";
import {
  registerBackgroundControlTools,
  registerBackgroundListTool,
} from "./shell/background-tools.ts";
import { resolveShell, type ShellProfile } from "./shell/profile.ts";
import { registerShellTranscriptRenderers } from "./shell/transcript.ts";
import {
  createShellStatusRefresher,
  type ShellStatusRefresher,
} from "./shell/status.ts";
import { analyzeCommand, unsupportedDialectMessage } from "./shell/analyze.ts";
import { surfaceCdAgents } from "./shell/cd-targets.ts";
import { runLspHook } from "./shell/lsp-hook.ts";
import { formatAgentsBlock } from "./lib/agents.ts";
import { cleanActivityDisplay } from "./lib/activity-details.ts";
import { loadText, render, renderLines, textPath } from "./lib/text.ts";
import {
  notifyOrphanedShells,
  surfaceCompletedShells,
} from "./shell/orphan.ts";
const SH_TOOL = "sh",
  SH_SIGNAL_TOOL = "sh_signal",
  SH_REPEAT_TOOL = "sh_repeat_until",
  SH_BACKGROUND_PS_TOOL = "sh_background_ps";
interface ShellText {
  sh: { description: string; prompt_snippet: string };
  sh_signal: { description: string; prompt_snippet: string };
  sh_detach: { description: string; prompt_snippet: string };
  sh_background_ps: { description: string; prompt_snippet: string };
  guidelines: {
    sh: string[];
    sh_signal: string[];
    sh_detach: string[];
    sh_background_ps: string[];
  };
  schema: {
    sh: Record<string, string>;
    sh_signal: Record<string, string>;
    sh_detach: Record<string, string>;
  };
  results: { sh_signal: Record<string, string> };
}
const SLEEP_UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
let shellStatus: ShellStatusRefresher | null = null;

function disableBuiltinBash(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  const all = pi.getAllTools();
  const withoutBash = active.filter((name) => {
    const tool = all.find(
      (t) => t.name === name && t.sourceInfo?.source === "builtin",
    );
    return tool?.name !== "bash";
  });
  if (withoutBash.length !== active.length) {
    pi.setActiveTools(withoutBash);
  }
}

export default async function (pi: ExtensionAPI) {
  registerTerminalCaptureTool(pi, captureSessionScreenshot);
  const cfg = loadShellConfig();
  const shell: ShellProfile = resolveShell(cfg.executable);
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
    () =>
      ({
        fd: false,
        rg: false,
        shuck: false,
        treeSitter: false,
      }) as ToolAvailability,
  );
  setCompletionHook((id, cmd, code, reason, log) => {
    signalHoldEvent();
    const isRepeat = id.startsWith("rpt-");
    const description = isRepeat
      ? undefined
      : getShellBackgrounds().find((entry) => entry.id === id)?.describe;
    const shellLabel = `PID=${id}${description ? ` · ${truncateDescribe(cleanActivityDisplay(description))}` : ""}`;
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
        ? `Shell ${shellLabel} completed on exit ${code}`
        : `Shell ${shellLabel} command failed on exit ${code ?? "unknown"}`;
    const hasRange =
      log && log.startLine !== undefined && log.endLine !== undefined;
    const summary = log
      ? `${base}; log ${log.path}${hasRange ? ` lines ${log.startLine}..${log.endLine}` : ""}`
      : base;
    const payload: Record<string, unknown> = {
      "shell-id": id,
      "exit-code": code ?? -1,
      summary,
    };
    const details = {
      kind,
      summary,
      payload,
      ...(log?.activityId && log.scope
        ? { deliveryId: JSON.stringify([log.scope, log.activityId]) }
        : {}),
    };
    sendNotification(pi, details, { deliverAs: "steer" });
  });

  const T = loadText<ShellText>("shell", textPath("shell"));
  const switches = {
    max_waitfor: MAX_WAITFOR,
    max_preview_lines: MAX_PREVIEW_LINES,
    windows: process.platform === "win32",
    fd: availability.fd,
    rg: availability.rg,
    shuck: availability.shuck,
    tree_sitter: availability.treeSitter,
    shell_invocation: shell.invocation,
    shell_name: shell.displayName,
  };
  const commonGuidelines = renderLines(T.guidelines.sh, switches);

  const shSchema = Type.Object({
    description: Type.String({
      minLength: 1,
      pattern: "\\S",
      description: T.schema.sh.description,
    }),
    waitfor: Type.Optional(
      Type.Number({ description: render(T.schema.sh.waitfor, switches) }),
    ),
    command: Type.String({ description: T.schema.sh.command }),
    env: Type.Optional(Type.String({ description: T.schema.sh.env })),
    is_pty: Type.Optional(Type.Boolean({ description: T.schema.sh.is_pty })),
  });

  pi.registerTool({
    name: SH_TOOL,
    label: "sh",
    description: render(T.sh.description, switches),
    promptSnippet: T.sh.prompt_snippet,
    promptGuidelines: commonGuidelines,
    parameters: shSchema,
    renderShell: "self",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const describe = params.description?.trim();
      const blocked = (
        reason: string,
        details: Record<string, unknown> = {},
        text = reason,
      ) => ({
        content: [{ type: "text" as const, text }],
        details: { describe, blocked: reason, ...details },
        isError: true,
      });
      if (signal?.aborted)
        return {
          content: [{ type: "text", text: "Aborted before start." }],
          details: undefined,
          isError: true,
        };
      if (params.waitfor !== undefined && params.waitfor > MAX_WAITFOR)
        return blocked(
          `waitfor must be <= ${MAX_WAITFOR}s (got ${params.waitfor}). For longer waits, background and use alarm.`,
        );
      const truncation: OutputTruncation = { maxLines: MAX_PREVIEW_LINES };
      const effectiveWaitfor = params.waitfor ?? DEFAULT_WAITFOR;
      // Inline sleep guard
      const sleepMatch = [
        ...params.command.matchAll(
          /(?:^|\s)sleep\s+(\d+(?:\.\d+)?)\s*([smhd])?\s*&&/g,
        ),
      ]
        .map((m) => parseFloat(m[1]) * (m[2] ? SLEEP_UNITS[m[2]] : 1))
        .find((sec) => sec > effectiveWaitfor);
      if (sleepMatch !== undefined) {
        const reason = `'sleep ${sleepMatch}s && ...' exceeds waitfor (${effectiveWaitfor}s). Background and use alarm.`;
        return blocked(reason, {}, `Blocked: ${reason}`);
      }

      const startedAt = Date.now();
      const shuckPath = availability.shuck ? getShuckBinPath() : null;
      const analysis = await analyzeCommand({
        command: params.command,
        shell,
        availability,
        shuckPath,
      });
      if (analysis.status === "unsupported-dialect") {
        return blocked(unsupportedDialectMessage(analysis.unsupported!));
      }
      const { parse } = analysis;
      if (analysis.errorText) {
        const { text, fullOutputPath } = await buildOutputText(
          analysis.errorText,
          {
            persistIfTruncated: true,
            emptyText: "(no detail)",
            truncation,
            tunables,
          },
        );
        const count = analysis.errorCount;
        return blocked(
          analysis.errorText,
          { fullOutputPath, shuckBlocked: true, tsAst: parse.ast },
          `${text}\n---\nblocked (${count} error${count !== 1 ? "s" : ""})`,
        );
      }

      const shuckWarnings = analysis.warningText || undefined;
      const cdAgents = surfaceCdAgents(parse.node);
      const slowDown = checkShellPoll(params.command);

      onUpdate?.({ content: [], details: undefined });
      const res = await runShell(
        params.command,
        effectiveWaitfor,
        buildShellEnvWithDotenv(ctx?.sessionManager, params.env),
        signal,
        (t) =>
          onUpdate?.({
            content: [{ type: "text", text: t }],
            details: undefined,
          }),
        describe,
        MAX_WAITFOR,
        truncation,
        tunables,
        shell,
        getCwd(),
        params.is_pty ?? false,
      );

      const tag = describe ? ` (${truncateDescribe(describe)})` : "";
      const status =
        res.status === "running"
          ? `running PID=${res.id}${tag}${res.cursor ? ` | ${res.cursor.bytes}B at L${res.cursor.line}:${res.cursor.column} -> ${res.fullOutputPath}` : ""}`
          : `exit ${res.exitCode ?? "unknown"}${tag}`;
      let text = res.text ? `${res.text}\n---\n${status}` : status;
      if (shuckWarnings)
        text = `linter warnings:\n${shuckWarnings}\n---\n${text}`;
      if (slowDown) text = `${slowDown}\n---\n${text}`;
      if (res.uid) text += `\nUID=${res.uid} socket=${res.socketPath}`;
      text += formatAgentsBlock(cdAgents);
      text += await runLspHook(availability.treeSitter ? parse.node : null);

      return {
        content: [{ type: "text", text }],
        details: {
          id: res.id,
          uid: res.uid,
          socketPath: res.socketPath,
          binaryPath: res.binaryPath,
          statusPath: res.statusPath,
          serverPid: res.serverPid,
          isPty: res.isPty,
          backendError: res.backendError,
          exitCode: res.exitCode,
          outputLines: res.outputLines,
          status: res.status,
          elapsedMs: Date.now() - startedAt,
          fullOutputPath: res.fullOutputPath,
          cursor: res.cursor,
          describe,
          shellName: shell.displayName,
          shuckWarnings,
          tsAst: parse.ast,
          cdAgentsFiles: cdAgents.map((f) => f.path),
        },
        isError:
          res.status === "completed" &&
          res.exitCode !== 0 &&
          res.exitCode !== null,
      };
    },
    renderCall(args, theme, context) {
      return renderCompactShellCall(
        args,
        theme,
        context,
        DEFAULT_WAITFOR,
        shell.displayName,
      );
    },
    renderResult(result, options, theme, context) {
      return renderCompactShellResult(
        result,
        options,
        theme,
        context,
        shell.displayName,
      );
    },
  });

  registerBackgroundControlTools(pi, T, switches);

  pi.registerTool(createRepeatTool(DESCRIBE_MAX, availability, shell));
  registerShellTranscriptRenderers();

  registerBackgroundListTool(pi, T, switches, truncateDescribe);

  pi.on("session_start", async (event, ctx) => {
    shellStatus?.dispose();
    shellStatus = createShellStatusRefresher(ctx);
    const dir = ctx.sessionManager?.getSessionDir();
    const scope = ctx.sessionManager?.getSessionId();
    setCurrentScope(scope);
    await bindShellPersistence(pi, ctx);
    await migrateShellRecords(ctx);
    acknowledgeShellNotifications(ctx);
    await resumeRepeats(pi, ctx, event.reason !== "fork");
    if (event.reason !== "fork") await surface_shell_shutdowns(pi, ctx);
    if (event.reason !== "fork" && event.reason !== "reload")
      await surfaceCompletedShells(
        dir,
        scope,
        ctx.sessionManager.getSessionFile(),
      );
    restoreShellActivities(scope);
    await resumeBackgroundShells(dir, scope);
    if (event.reason !== "fork" && event.reason !== "reload")
      void notifyOrphanedShells(dir, scope);
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
        .map(
          (b) =>
            `[${b.id}${b.describe ? " " + truncateDescribe(b.describe) : ""}]`,
        )
        .join(", ")}`,
    deadlineMs: 5 * 60 * 1000,
    onAbort: killAll,
  });

  pi.on("session_tree", async (_event, ctx) => {
    await resumeRepeats(pi, ctx);
  });

  pi.on("turn_end", (_event, ctx) => acknowledgeShellNotifications(ctx));
  pi.on("agent_settled", (_event, ctx) => acknowledgeShellNotifications(ctx));

  pi.on("session_shutdown", async (event, ctx) => {
    suspendShellWrites(ctx, event.reason);
    suspendRepeatWrites(ctx, event.reason);
    shellStatus?.dispose();
    shellStatus = null;
  });
}
