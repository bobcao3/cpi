/**
 * Custom shell extension (`sh` + `sh_send_signal`)
 *
 * Replaces the built-in blocking `bash` tool with a stateless shell runner.
 * Each `sh` call is an independent, fresh `bash -c` invocation — there is no
 * session reuse, no persisted env/cwd, and no ids to manage in the common case.
 *
 * `sh` parameters:
 *   - command: shell command to execute
 *   - waitfor: seconds to wait before returning while the process keeps running
 *     (default 5, maximum 30)
 *
 * If a command is still running when `waitfor` elapses, it is left running in
 * the background, `sh` returns its PID as the background id plus the partial
 * output, and a custom `shell-session-ended` follow-up message fires when it
 * eventually exits. Use `sh_send_signal` with that PID to signal it (SIGKILL to
 * terminate).
 *
 * `sh_send_signal` parameters:
 *   - id: background shell PID to target
 *   - signal: signal name/number to send (default SIGINT; SIGKILL to terminate)
 */

import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensureShellTools, getToolEnv, type ToolAvailability } from "./shell/tools.ts";
import {
  getActiveBackgrounds,
  getActiveBackgroundIds,
  hasActiveBackground,
  killAll,
  runShell,
  setCompletionHook,
  signalChild,
  silenceChild,
} from "./shell/exec.ts";

const SH_TOOL = "sh";
const SH_SEND_SIGNAL_TOOL = "sh_send_signal";
const SESSION_ENDED_MESSAGE_TYPE = "shell-session-ended";
const DEFAULT_WAITFOR = 5;
const MAX_WAITFOR = 30;

const SLEEP_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

// Find a `sleep T && ...` (busy-wait) whose T exceeds the waitfor window.
// Matches `(ws)sleep(ws)T(ws)&&` with an optional GNU sleep suffix (s/m/h/d).
function offendingSleep(command: string, waitfor: number): number | null {
  const re = /(?:^|\s)sleep\s+(\d+(?:\.\d+)?)\s*([smhd])?\s*&&/g;
  for (let m = re.exec(command); m !== null; m = re.exec(command)) {
    const seconds = parseFloat(m[1]) * (m[2] ? SLEEP_UNIT_SECONDS[m[2]] : 1);
    if (seconds > waitfor) return seconds;
  }
  return null;
}

let holdNoticeSent = false;
let lastStopReason: string | undefined;

interface SessionEndedDetails {
  id: string;
  exitCode: number | null;
}

const shSchema = Type.Object({
  command: Type.String({ description: "Command to run" }),
  waitfor: Type.Optional(
    Type.Number({
      description: "Seconds to wait before backgrounding (default 5, max 30; >30 errors)",
    }),
  ),
  describe: Type.Optional(
    Type.String({ description: "Short description of what this command is doing (a few words)" }),
  ),
});

const shSendSignalSchema = Type.Object({
  id: Type.String({ description: "Background shell PID (as returned by sh)" }),
  signal: Type.Optional(
    Type.String({ description: "Signal name/number (default SIGINT; SIGKILL to terminate)" }),
  ),
});

export default async function (pi: ExtensionAPI) {
  const availability = await ensureShellTools().catch((err) => {
    console.warn("[shell-ext] Binary tool setup failed:", err);
    return { fd: false, rg: false } as ToolAvailability;
  });

  pi.registerMessageRenderer(SESSION_ENDED_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as SessionEndedDetails | undefined;
    const id = details?.id ?? "unknown";
    const exitCode = details?.exitCode ?? "unknown";
    const line1 = `${theme.fg("toolTitle", "Shell command ended")}: ${id} (exit code ${exitCode})`;
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(line1, 0, 0));
    return box;
  });

  setCompletionHook((id, _cmd, code) =>
    pi.sendMessage(
      {
        customType: SESSION_ENDED_MESSAGE_TYPE,
        content: `Shell ${id} exited ${code}`,
        display: true,
        details: { id, exitCode: code } satisfies SessionEndedDetails,
      },
      { deliverAs: "followUp", triggerTurn: true },
    ),
  );

  const guidelines: string[] = [
    "Each sh call = fresh `bash -c`. No session reuse; env/cwd/shell state don't persist.",
    "Always pass a short `describe` parameter (a few words) explaining the command's purpose; it appears in hold/background notifications.",
    "Keep waitfor <=30s. On overflow, sh returns the command's PID as its background id + partial output.",
    "Signal a bg shell via sh_send_signal with its PID; send SIGKILL to terminate.",
    "You will receive a notification once a background shell completes, feel free to relinquish control if you need to wait.",
    "Do not set alarm for 'checking on backgrounded shell', you will be waken up once background notifies",
    "Avoid polling, but if you really have to, use the `alarm` tool instead of a long `sleep &&` command. It will also notify you when triggered.",
    "If a background shell completes and you decide no follow up needed, say 'ACK' exactly.",
  ];
  if (availability.fd) {
    guidelines.push("Search files with `$ fd` not `$ find`: fd [OPTS] [pattern] [path]...");
  }
  if (availability.rg) {
    guidelines.push("Search content with `$ rg` not `$ grep`: rg [OPTS] PATTERN [path]...");
  }

  pi.registerTool({
    name: SH_TOOL,
    label: "sh",
    description:
      "Run a command via `bash -c`. Stateless: no env/cwd persistence. Outliving waitfor backgrounds it and returns an id for signalling. Maximum waitfor is 30s.",
    promptSnippet: "Run shell commands",
    promptGuidelines: guidelines,
    parameters: shSchema,
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Aborted before start." }],
          isError: true,
        };
      }

      if (params.waitfor !== undefined && params.waitfor > MAX_WAITFOR) {
        return {
          content: [
            {
              type: "text",
              text: `waitfor must be <= ${MAX_WAITFOR}s (got ${params.waitfor}). For longer waits, background the command and use alarm instead of a large waitfor.`,
            },
          ],
          isError: true,
        };
      }

      const effectiveWaitfor = params.waitfor ?? DEFAULT_WAITFOR;
      const sleptFor = offendingSleep(params.command, effectiveWaitfor);
      if (sleptFor !== null) {
        return {
          content: [
            {
              type: "text",
              text: `Blocked: 'sleep ${sleptFor}s && ...' waits longer than waitfor (${effectiveWaitfor}s). Background the command and use alarm instead of busy-waiting.`,
            },
          ],
          isError: true,
        };
      }

      // Prime the tool-call renderer so the command line appears immediately.
      onUpdate?.({ content: [], details: undefined });

      const describe = params.describe?.trim();
      const res = await runShell(
        params.command,
        params.waitfor ?? DEFAULT_WAITFOR,
        getToolEnv(),
        signal,
        (text) => onUpdate?.({ content: [{ type: "text", text }], details: undefined }),
        describe,
      );

      const describeTag = describe ? ` (${truncateDescribe(describe)})` : "";
      let status: string;
      if (res.status === "running") {
        const c = res.cursor;
        const cursor = c
          ? ` | ${c.bytes}B at L${c.line}:${c.column} -> ${res.fullOutputPath} (read from cursor)`
          : "";
        status = `running PID=${res.id}${describeTag} ${cursor}`;
      } else {
        status = `exit ${res.exitCode ?? "unknown"}${describeTag}`;
      }
      const text = res.text ? `${res.text}\n---\n${status}` : status;

      return {
        content: [{ type: "text", text }],
        details: {
          id: res.id,
          exitCode: res.exitCode,
          status: res.status,
          fullOutputPath: res.fullOutputPath,
          cursor: res.cursor,
          describe,
        },
        isError: res.status === "completed" && res.exitCode !== 0 && res.exitCode !== null,
      };
    },
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      const waitfor = args.waitfor ?? DEFAULT_WAITFOR;
      const waitforSuffix = waitfor ? theme.fg("muted", ` (waitfor ${waitfor}s)`) : "";
      text.setText(theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + waitforSuffix);
      return text;
    },
  });

  pi.registerTool({
    name: SH_SEND_SIGNAL_TOOL,
    label: "sh_send_signal",
    description:
      "Signal a background shell command by its PID (sh-returned). Send SIGKILL to terminate.",
    promptSnippet: "Signal background shell commands",
    promptGuidelines: [
      "E.g. terminate: id='12345', signal='SIGKILL'.",
      "Default SIGINT, delivered to the whole process group.",
    ],
    parameters: shSendSignalSchema,
    async execute(_toolCallId, params) {
      const signal = params.signal ?? "SIGINT";
      const ok = signalChild(params.id, signal);
      if (!ok) {
        return {
          content: [{ type: "text", text: `Background ${params.id} not active.` }],
          isError: true,
        };
      }
      // Suppress the shell-session-ended follow-up that would otherwise fire when the
      // signaled process exits; the agent already has the result of this tool call.
      silenceChild(params.id);
      return {
        content: [{ type: "text", text: `Sent ${signal} to ${params.id}.` }],
        details: { id: params.id, signal, completionNoticeSuppressed: true },
      };
    },
  });

  pi.on("session_start", async () => {
    const active = pi.getActiveTools();
    const withoutBuiltinBash = active.filter((name) => name !== "bash");
    const next = new Set([...withoutBuiltinBash, SH_TOOL, SH_SEND_SIGNAL_TOOL]);
    pi.setActiveTools(Array.from(next));
  });

  const truncateDescribe = (text: string, max = 48) => {
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1)}…`;
  };

  const formatActiveBackgrounds = () => {
    const backgrounds = getActiveBackgrounds();
    const parts = backgrounds.map((bg) => {
      const desc = bg.describe ? ` ${truncateDescribe(bg.describe)}` : "";
      return `[${bg.id}${desc}]`;
    });
    return `active background shells: ${parts.join(", ")}`;
  };

  const emitHoldMessage = (ctx: ExtensionContext) => {
    const text = formatActiveBackgrounds();
    // Write to stderr only; do not inject a custom message into the model context.
    process.stderr.write(`[shell-hold] ${text}\n`);
    if (ctx.hasUI) {
      ctx.ui.notify(text, "info");
    }
  };

  pi.on("agent_start", () => {
    lastStopReason = undefined;
    holdNoticeSent = false;
  });

  pi.on("agent_end", (event, ctx) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m.role === "assistant") {
        lastStopReason = (m as any).stopReason;
        break;
      }
    }

    if (ctx.hasUI) return;
    if (lastStopReason === "error" || lastStopReason === "aborted") return;
    if (!hasActiveBackground()) return;

    if (!holdNoticeSent) {
      emitHoldMessage(ctx);
      holdNoticeSent = true;
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Interactive sessions and non-exit reasons should not hold the process.
    if (ctx.hasUI || event.reason !== "quit") {
      killAll();
      return;
    }

    if (!hasActiveBackground()) {
      killAll();
      return;
    }
    if (lastStopReason === "error" || lastStopReason === "aborted") {
      killAll();
      return;
    }

    if (!holdNoticeSent) {
      emitHoldMessage(ctx);
      holdNoticeSent = true;
    }

    // Keep the session/runtime alive until all background shells finish and the agent stays idle
    // long enough for any queued follow-up turn to complete.
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!hasActiveBackground() && ctx.isIdle()) {
          setTimeout(() => {
            if (!hasActiveBackground() && ctx.isIdle()) {
              resolve();
            } else {
              setTimeout(check, 100);
            }
          }, 500);
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });

    killAll();
  });
}
