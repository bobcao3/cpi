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

export type NotificationKind =
  | "alarm"
  | "shell-complete"
  | "shell-failed"
  | "repeat-stopped"
  | "repeat-breach";

export interface RawXmlValue {
  __rawXml: string;
}

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
 * Nested objects are rendered as child XML elements.
 * Values shaped as { __rawXml: "..." } are inserted verbatim.
 */
export function wrapNotification(details: NotificationDetails): string {
  const lines: string[] = [`<notification type="${details.kind}">`];
  lines.push(...renderPayload(details.payload, "  "));
  lines.push("</notification>");
  return lines.join("\n");
}

function isRawXmlValue(value: unknown): value is RawXmlValue {
  return typeof value === "object" && value !== null && "__rawXml" in value;
}

function renderPayload(payload: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null) continue;
    if (isRawXmlValue(value)) {
      lines.push(`${indent}${value.__rawXml}`);
    } else if (typeof value === "object" && !Array.isArray(value)) {
      const childLines = renderPayload(value as Record<string, unknown>, indent + "  ");
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
    } else {
      icon = "•";
      iconColor = "muted";
    }

    const text = new Text(`${theme.fg(iconColor, icon)} ${theme.fg("muted", summary)}`, 0, 0);
    return text;
  });
}

/**
 * Ensure the shared notification renderer is registered exactly once across all
 * jiti-loaded extension instances.
 *
 * pi loads each extension via jiti with `moduleCache: false`, so a module-level
 * boolean would NOT be shared between importers and each load would re-register.
 * The flag therefore lives on `globalThis`, process-wide and identical across
 * jiti loads (same pattern as lib/footer.ts and lib/transcript-registry.ts).
 */
const NOTIFICATION_RENDERER_FLAG = "__cpiNotificationRendererEnsured";

export function ensureNotificationRenderer(pi: ExtensionAPI): void {
  const g = globalThis as Record<string, unknown>;
  if (g[NOTIFICATION_RENDERER_FLAG]) return;
  registerNotificationRenderer(pi);
  g[NOTIFICATION_RENDERER_FLAG] = true;
}
