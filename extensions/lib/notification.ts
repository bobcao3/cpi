/**
 * Shared notification module for delivering async events (alarm firings,
 * background shell completions) to the LLM.
 *
 * Notifications are injected as user-role messages wrapped in <notification>
 * XML so the model can distinguish them from real human input.
 *
 * The TUI renderer produces a minimal one-liner — distinct from tool output
 * and conversation messages.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const NOTIFICATION_TYPE = "notification";

export type NotificationKind = "alarm" | "shell-complete" | "repeat-triggered" | "repeat-breach";

export interface NotificationDetails {
  kind: NotificationKind;
  /** Human-readable summary for TUI display (not included in XML) */
  summary: string;
  /** Kind-specific payload */
  payload: Record<string, unknown>;
}

/**
 * Wrap notification content in XML for LLM delivery.
 * The model sees this as a user-role message but can pattern-match the
 * <notification> tag to distinguish it from real user input.
 */
export function wrapNotification(details: NotificationDetails): string {
  const lines: string[] = [`<notification type="${details.kind}">`];
  for (const [key, value] of Object.entries(details.payload)) {
    if (value !== undefined && value !== null) {
      lines.push(`  <${key}>${escapeXml(String(value))}</${key}>`);
    }
  }
  lines.push("</notification>");
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Send a notification via pi.sendMessage(), wrapped in <notification> XML.
 * The message is delivered as a user-role message that triggers a turn.
 */
export function sendNotification(
  pi: ExtensionAPI,
  details: NotificationDetails,
  options: { deliverAs?: "steer" | "followUp" | "nextTurn" } = {},
): void {
  const xml = wrapNotification(details);
  pi.sendMessage(
    {
      customType: NOTIFICATION_TYPE,
      content: xml,
      display: true,
      details,
    },
    {
      triggerTurn: true,
      deliverAs: options.deliverAs ?? "followUp",
    },
  );
}

/**
 * Register the shared TUI renderer for notifications.
 * Produces a minimal one-liner distinct from tool output and conversation.
 */
export function registerNotificationRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(NOTIFICATION_TYPE, (message, _options, theme) => {
    const details = message.details as NotificationDetails | undefined;
    const kind = details?.kind ?? "unknown";
    const summary = details?.summary ?? message.content;

    let icon: string;
    let iconColor: string;
    if (kind === "alarm") {
      icon = "⏰";
      iconColor = "warning";
    } else if (kind === "shell-complete") {
      const code = (details?.payload?.["exit-code"] as number | undefined) ?? null;
      icon = code === 0 ? "✓" : "✗";
      iconColor = code === 0 ? "success" : "error";
    } else if (kind === "repeat-triggered") {
      icon = "✓";
      iconColor = "success";
    } else if (kind === "repeat-breach") {
      icon = "⚠";
      iconColor = "warning";
    } else {
      icon = "•";
      iconColor = "muted";
    }

    const text = new Text(`${theme.fg(iconColor, icon)} ${theme.fg("muted", summary)}`, 0, 0);
    return text;
  });
}
