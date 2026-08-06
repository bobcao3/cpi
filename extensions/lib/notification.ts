/**
 * Shared notification module for delivering async events to the LLM as
 * user-role messages wrapped in <notification> XML (distinct from user input).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const NOTIFICATION_TYPE = "notification";

export type NotificationKind =
  | "alarm"
  | "shell-complete"
  | "shell-failed"
  | "repeat-stopped"
  | "repeat-breach"
  | "orphaned-shells"
  | "completed-shells";

export interface RawXmlValue {
  __rawXml: string;
}

export interface NotificationDetails {
  kind: NotificationKind;
  /** Human-readable summary for TUI display (not included in XML) */
  summary: string;
  payload: Record<string, unknown>;
}

/** Wrap content in XML: nested objects become child elements; { __rawXml } values are inserted verbatim. */
export function wrapNotification(details: NotificationDetails): string {
  const lines: string[] = [`<notification type="${details.kind}">`];
  lines.push(...renderPayload(details.payload, "  "));
  lines.push("</notification>");
  return lines.join("\n");
}

function isRawXmlValue(value: unknown): value is RawXmlValue {
  return typeof value === "object" && value !== null && "__rawXml" in value;
}

function renderPayload(
  payload: Record<string, unknown>,
  indent: string,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (isRawXmlValue(value)) {
      lines.push(`${indent}${value.__rawXml}`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const childLines = renderPayload(
        value as Record<string, unknown>,
        indent + "  ",
      );
      if (childLines.length) {
        lines.push(`${indent}<${key}>`);
        lines.push(...childLines);
        lines.push(`${indent}</${key}>`);
      }
    } else {
      lines.push(`${indent}<${key}>${escapeXml(String(value))}</${key}>`);
    }
  }
  return lines;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
 * Register the notification TUI renderer — owner core.ts re-registers on every
 * load (renderers live on the transient extension instance).
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
      icon = "✓";
      iconColor = "success";
    } else if (kind === "shell-failed") {
      icon = "✗";
      iconColor = "error";
    } else if (kind === "repeat-stopped") {
      icon = "•";
      iconColor = "muted";
    } else if (kind === "repeat-breach") {
      icon = "⚠";
      iconColor = "warning";
    } else if (kind === "orphaned-shells") {
      icon = "⛓";
      iconColor = "muted";
    } else if (kind === "completed-shells") {
      icon = "✓";
      iconColor = "muted";
    } else {
      icon = "•";
      iconColor = "muted";
    }

    const text = new Text(
      `${theme.fg(iconColor, icon)} ${theme.fg("muted", summary)}`,
      0,
      0,
    );
    return text;
  });
}
