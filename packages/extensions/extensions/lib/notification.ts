/** Delivers async events to the LLM as user-role messages wrapped in <notification> XML, distinct from user input. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  ToolTreeComponent,
  createTreeState,
  type ToolTreeNode,
  type TreeState,
} from "../tree/index.ts";
import { compactedNotificationFilter } from "./compaction-display.ts";
import { style_tool_tree } from "./tool-style.ts";

export const NOTIFICATION_TYPE = "notification";

export type NotificationKind =
  | "external-event"
  | "alarm"
  | "shell-complete"
  | "shell-failed"
  | "repeat-stopped"
  | "repeat-breach"
  | "model-change"
  | "orphaned-shells"
  | "interrupted-shells"
  | "completed-shells";

export interface RawXmlValue {
  __rawXml: string;
}

export interface NotificationDetails {
  kind: NotificationKind;
  /** Human-readable summary for TUI display (not included in XML) */
  summary: string;
  payload: Record<string, unknown>;
  description?: string;
  log?: { path: string; startLine?: number; endLine?: number };
}

/** Nested objects become child elements; __rawXml values are inserted verbatim. */
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

/** Re-register because renderers are transient per extension instance. */
export function registerNotificationRenderer(pi: ExtensionAPI): void {
  const compacted = compactedNotificationFilter(pi);
  const states = new WeakMap<object, TreeState>();
  const statuses: Partial<Record<NotificationKind, ToolTreeNode["status"]>> = {
    alarm: "warning",
    "shell-complete": "success",
    "shell-failed": "error",
    "repeat-stopped": "paused",
    "repeat-breach": "warning",
    "interrupted-shells": "warning",
    "completed-shells": "success",
  };
  pi.registerMessageRenderer<NotificationDetails>(
    NOTIFICATION_TYPE,
    (message, options, theme) => {
      const hidden = compacted(message);
      if (hidden) return hidden;
      const details = message.details;
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
      const summary = details?.summary ?? content;
      const shell_id = details?.payload?.["shell-id"];
      const exit_code = details?.payload?.["exit-code"];
      const shell =
        typeof shell_id === "string" &&
        [
          "shell-complete",
          "shell-failed",
          "repeat-stopped",
          "repeat-breach",
        ].includes(details?.kind ?? "");
      const repeat =
        details?.kind === "repeat-stopped" || details?.kind === "repeat-breach";
      const children: ToolTreeNode[] = [];
      if (details?.log)
        children.push({
          id: "notification/log",
          label: "Log",
          summary:
            details.log.startLine !== undefined &&
            details.log.endLine !== undefined
              ? `lines ${details.log.startLine}..${details.log.endLine}`
              : undefined,
          content: { text: details.log.path },
        });
      children.push({
        id: "notification/details",
        label: "Details",
        content: { text: content },
      });
      let state = states.get(message);
      if (!state) states.set(message, (state = createTreeState()));
      const tree = new ToolTreeComponent(
        style_tool_tree(
          [
            {
              id: "notification",
              label: shell ? (repeat ? "Monitor" : "Shell") : summary,
              summary: shell ? details?.description : undefined,
              metadata: shell
                ? [
                    `${repeat ? "ID" : "PID"}=${shell_id}`,
                    `exit ${exit_code ?? "unknown"}`,
                  ]
                : [],
              status: details ? statuses[details.kind] : undefined,
              children,
              defaultOpen: false,
            },
          ],
          theme,
        ),
        theme,
        { padding: 0, state },
      );
      tree.setExpanded(options.expanded);
      return tree;
    },
  );
}
