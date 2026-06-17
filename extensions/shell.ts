/**
 * Custom shell extension (`sh` + `sh_send_signal`)
 *
 * Replaces the built-in blocking `bash` tool with a stateless shell runner.
 * Each `sh` call is an independent, fresh `bash -c` invocation — there is no
 * session reuse, no persisted env/cwd, and no ids to manage in the common case.
 *
 * `sh` parameters:
 *   - command: shell command to execute
 *   - waitfor: seconds to wait before returning while the process keeps running (configurable
 *     via cpi-config.json; default 5, maximum 30)
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
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadShellConfig } from "./lib/config.ts";
import { registerNotificationRenderer, sendNotification } from "./lib/notification.ts";
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
const TAIL_LINES = 5;

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

const shSendSignalSchema = Type.Object({
  id: Type.String({ description: "Background shell PID (as returned by sh)" }),
  signal: Type.Optional(
    Type.String({ description: "Signal name/number (default SIGINT; SIGKILL to terminate)" }),
  ),
});

const RESET = "\x1b[0m";

function truncateLine(line: string, width: number): string {
  const truncated = truncateToWidth(line, width, "…");
  // truncateToWidth inserts a reset before the ellipsis, which clears the
  // container's background color. Drop that reset so the block background
  // continues through the ellipsis.
  return truncated.replace(`${RESET}…`, "…");
}

function truncatedPreview(
  lines: string[],
  summary: string,
): { invalidate(): void; render(width: number): string[] } {
  return {
    invalidate() {},
    render(width: number): string[] {
      return [...lines.map((l) => truncateLine(l, width)), truncateLine(summary, width)];
    },
  };
}

export default async function (pi: ExtensionAPI) {
  // Load configurable waitfor parameters from cpi-config.json.
  // Falls back to built-in defaults (5s / 30s) if not configured.
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
  const availability = await ensureShellTools().catch((err) => {
    console.warn("[shell-ext] Binary tool setup failed:", err);
    return { fd: false, rg: false } as ToolAvailability;
  });

  registerNotificationRenderer(pi);

  setCompletionHook((id, _cmd, code) =>
    sendNotification(
      pi,
      {
        kind: "shell-complete",
        summary: `Shell ${id} exited ${code}`,
        payload: {
          "shell-id": id,
          "exit-code": code ?? -1,
        },
      },
      { deliverAs: "followUp" },
    ),
  );

  const guidelines: string[] = [
    "Each sh call = fresh `bash -c`. No session reuse; env/cwd/shell state don't persist.",
    "Always pass a short `describe` parameter (a few words) explaining the command's purpose; it appears in hold/background notifications.",
    `Keep waitfor <=${MAX_WAITFOR}s. On overflow, sh returns the command's PID as its background id + partial output.`,
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
      "Run a command via `bash -c`. Stateless: no env/cwd persistence. Outliving waitfor backgrounds it and returns an id for signalling. Maximum waitfor is " +
      MAX_WAITFOR +
      "s.",
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
        MAX_WAITFOR,
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
      const cmdLines = args.command.split("\n");

      if (cmdLines.length <= TAIL_LINES) {
        text.setText(theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + waitforSuffix);
      } else if (context.expanded) {
        const first = theme.fg("toolTitle", theme.bold(`$ ${cmdLines[0]}`));
        const rest = cmdLines
          .slice(1)
          .map((l: string) => theme.fg("toolTitle", l))
          .join("\n");
        text.setText(
          first + "\n" + rest + theme.fg("dim", " · Ctrl+O to collapse") + waitforSuffix,
        );
      } else {
        // Collapsed: first line + ... + last 4, all bold white
        const tailStart = cmdLines.length - 3;
        const hint = theme.fg("dim", ` showing ${tailStart}-${cmdLines.length} (Ctrl+O to expand)`);
        const first = theme.fg("toolTitle", theme.bold(`$ ${cmdLines[0]}`)) + hint + waitforSuffix;
        const ellipsis = theme.fg("dim", "...");
        const tail = cmdLines
          .slice(-4)
          .map((l: string) => theme.fg("toolTitle", theme.bold(l)))
          .join("\n");
        text.setText(first + "\n" + ellipsis + "\n" + tail);
      }
      return text;
    },

    renderResult(result, { expanded, isPartial }, theme, _context) {
      const content = result.content[0];
      const fullText = content?.type === "text" ? content.text : "";

      // Split output from status line (execute appends "\n---\n<status>")
      const sepIdx = fullText.indexOf("\n---\n");
      const outputText = sepIdx !== -1 ? fullText.slice(0, sepIdx) : fullText;
      const outputLines = outputText
        .trimEnd()
        .split("\n")
        .filter((l: string) => l !== "");
      const totalLines = outputLines.length;

      // ── Streaming: live tail ──
      if (isPartial) {
        const tail = outputLines.slice(-TAIL_LINES);
        const hidden = outputLines.length - tail.length;
        let summary = theme.fg("warning", "⏳ running");
        if (hidden > 0) {
          summary += theme.fg(
            "dim",
            ` · showing L${hidden + 1}-${outputLines.length} (Ctrl+O to expand)`,
          );
        } else {
          summary += theme.fg("dim", ` · ${outputLines.length} lines`);
        }
        if (outputText.trim()) {
          return new Text(
            tail.map((l: string) => theme.fg("toolOutput", l)).join("\n") + "\n" + summary,
            0,
            0,
          );
        }
        return new Text(summary, 0, 0);
      }

      // ── Completed ──
      const details = result.details as
        | {
            id?: string;
            exitCode?: number | null;
            status?: string;
            fullOutputPath?: string;
            describe?: string;
          }
        | undefined;
      const isRunning = details?.status === "running";
      const exitCode = details?.exitCode;

      // Status icon
      let status = "";
      if (isRunning) {
        status = theme.fg("warning", "⏳ backgrounded");
        if (details?.id) status += theme.fg("dim", ` PID=${details.id}`);
        if (details?.fullOutputPath) status += theme.fg("dim", ` · ${details.fullOutputPath}`);
      } else if (exitCode !== null && exitCode !== undefined && exitCode !== 0) {
        status = theme.fg("error", `exit ${exitCode}`);
      } else {
        status = theme.fg("success", "✓");
      }

      if (expanded) {
        // ── Expanded: full output, summary at end ──
        let summary = status + theme.fg("dim", ` · ${totalLines} lines · Ctrl+O to collapse`);
        if (details?.fullOutputPath) {
          summary += theme.fg("warning", " [truncated]");
        }
        let t = "";
        if (totalLines > 0) {
          t = outputLines.map((l: string) => theme.fg("toolOutput", l)).join("\n");
        } else {
          t = theme.fg("dim", "(no output)");
        }
        if (details?.fullOutputPath) {
          t += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
        }
        return new Text(t + "\n" + summary, 0, 0);
      }

      // ── Collapsed (default): tail TAIL_LINES, summary at end ──
      if (totalLines === 0) {
        return new Text(theme.fg("dim", "(no output)") + "\n" + status, 0, 0);
      }

      if (totalLines <= TAIL_LINES) {
        const summary = status + theme.fg("dim", ` · ${totalLines} lines`);
        return truncatedPreview(
          outputLines.map((l: string) => theme.fg("toolOutput", l)),
          summary,
        );
      }

      const startLine = totalLines - TAIL_LINES + 1;
      let summary =
        status + theme.fg("dim", ` · showing L${startLine}-${totalLines} (Ctrl+O to expand)`);
      if (details?.fullOutputPath) {
        summary += theme.fg("warning", " [truncated]");
      }
      const tail = outputLines.slice(-TAIL_LINES);
      return truncatedPreview(
        tail.map((l: string) => theme.fg("toolOutput", l)),
        summary,
      );
    },
  });

  pi.registerTool({
    name: SH_SEND_SIGNAL_TOOL,
    label: "sh_send_signal",
    description:
      "Signal a background shell command by its PID (sh-returned). Send SIGKILL to terminate background shell process-group.",
    promptSnippet: "Signal background shell commands",
    promptGuidelines: [
      "Default SIGINT, delivered to the whole process group.",
      "Avoid using `sh $ kill` against background shell PIDs, use `sh_send_signal` tool instead.",
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
