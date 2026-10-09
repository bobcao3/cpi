import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  sendNotification,
  type NotificationKind,
} from "../lib/notification.ts";
import { signalHoldEvent } from "../lib/session-hold.ts";
import { cleanActivityDisplay } from "../lib/activity-details.ts";
import { loadText, render, textPath } from "../lib/text.ts";
import { getShellBackgrounds, setCompletionHook } from "./exec.ts";

export function disable_builtin_bash(pi: ExtensionAPI): void {
  const active = pi.getActiveTools();
  const all = pi.getAllTools();
  const without_bash = active.filter((name) => {
    const tool = all.find(
      (candidate) =>
        candidate.name === name && candidate.sourceInfo?.source === "builtin",
    );
    return tool?.name !== "bash";
  });
  if (without_bash.length !== active.length) pi.setActiveTools(without_bash);
}

export function register_shell_completion(
  pi: ExtensionAPI,
  truncate_description: (text: string) => string,
): void {
  const text = loadText<{ completion: Record<string, string> }>(
    "shell",
    textPath("shell"),
  );
  setCompletionHook((id, _command, code, reason, log) => {
    signalHoldEvent();
    const is_repeat = id.startsWith("rpt-");
    const description = is_repeat
      ? undefined
      : getShellBackgrounds().find((entry) => entry.id === id)?.describe;
    const shell_label = `PID=${id}${description ? ` · ${truncate_description(cleanActivityDisplay(description))}` : ""}`;
    const kind: NotificationKind = is_repeat
      ? reason === "breach"
        ? "repeat-breach"
        : "repeat-stopped"
      : code === 0
        ? "shell-complete"
        : "shell-failed";
    const base = render(text.completion[kind], {
      id,
      code: code ?? "unknown",
      shell_label,
    });
    const has_range =
      log && log.startLine !== undefined && log.endLine !== undefined;
    const summary = log
      ? render(text.completion.summary, {
          base,
          path: log.path,
          has_range,
          start: log.startLine,
          end: log.endLine,
        })
      : base;
    sendNotification(
      pi,
      {
        kind,
        summary,
        payload: { "shell-id": id, "exit-code": code ?? -1, summary },
        description: description
          ? truncate_description(cleanActivityDisplay(description))
          : undefined,
        log: log
          ? { path: log.path, startLine: log.startLine, endLine: log.endLine }
          : undefined,
        ...(log?.activityId && log.scope
          ? { deliveryId: JSON.stringify([log.scope, log.activityId]) }
          : {}),
      },
      { deliverAs: "steer" },
    );
  });
}
