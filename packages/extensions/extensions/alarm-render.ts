import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "./tree/index.ts";
import { style_tool_tree } from "./lib/tool-style.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AlarmDetails } from "./alarm.ts";
import { cleanActivityDisplay } from "./lib/activity-details.ts";

interface AlarmArgs {
  cancel?: boolean | string;
  alarm_id?: string;
  relative_seconds?: number;
  target_time?: string;
  message?: string;
}
const visible = (value: string) => cleanActivityDisplay(value).trim();
const absolute = (ms: number) =>
  Number.isFinite(ms) ? new Date(ms).toISOString() : "invalid time";

export function render_alarm_tree(
  snapshot: ToolTreeSnapshot<AlarmArgs, AlarmDetails>,
  theme: Theme,
  context: Pick<ToolTreeContext, "toolCallId">,
): readonly ToolTreeNode[] {
  const { args, result, phase } = snapshot;
  const raw =
    result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  const details = result?.details;
  const failed =
    snapshot.isError || (result as { isError?: boolean } | undefined)?.isError;
  const cancel = args.cancel !== undefined && args.cancel !== false;
  const missing =
    details?.operation === "missing" || raw.startsWith("No active alarm");
  const separator = raw.startsWith("Alarm ") ? raw.lastIndexOf(" at ") : -1;
  const id =
    details?.alarmId ??
    (separator > 6 ? raw.slice(6, separator) : args.alarm_id);
  const alarm = cancel
    ? undefined
    : details?.alarms.find((entry) => entry.id === id);
  const owner = context.toolCallId;
  const children: ToolTreeNode[] = [];
  const metadata: string[] = [];
  if (failed)
    children.push({
      id: `${owner}/failure`,
      label: "Failure",
      status: "error",
      content: { text: raw },
      defaultOpen: true,
    });
  else if (alarm) {
    metadata.push(absolute(alarm.targetMs));
    if (args.relative_seconds !== undefined)
      metadata.push(`in ${args.relative_seconds}s when scheduled`);
    children.push({
      id: `${owner}/alarm/${encodeURIComponent(alarm.id)}`,
      label: `Alarm ${visible(alarm.id)}`,
      summary: "scheduled",
      metadata: [absolute(alarm.targetMs)],
      children: [
        {
          id: `${owner}/alarm/${encodeURIComponent(alarm.id)}/message`,
          label: "Message",
          content: { text: alarm.message },
        },
      ],
    });
  } else if (phase === "complete") {
    children.push({
      id: `${owner}/outcome`,
      label: missing ? "Missing alarm" : "Outcome",
      content: { text: raw },
    });
    for (const cancelledId of details?.cancelledIds ?? [])
      children.push({
        id: `${owner}/cancelled/${encodeURIComponent(cancelledId)}`,
        label: `Alarm ${visible(cancelledId)}`,
        summary: "cancelled",
        status: "cancelled",
      });
  }
  if (cancel && phase === "complete" && !failed)
    metadata.push(`${details?.alarms.length ?? 0} alarms remain`);
  if (!cancel && !alarm && phase !== "complete") {
    if (args.relative_seconds !== undefined)
      metadata.push(`in ${args.relative_seconds}s`);
    if (args.target_time) metadata.push(visible(args.target_time));
    if (args.message)
      children.push({
        id: `${owner}/message`,
        label: "Message",
        content: { text: args.message },
      });
  }
  return style_tool_tree(
    [
      {
        id: owner,
        label: theme.fg(
          failed
            ? "error"
            : missing
              ? "muted"
              : phase === "complete"
                ? "success"
                : "warning",
          "Alarm",
        ),
        summary: failed
          ? "failed"
          : cancel
            ? missing
              ? visible(raw)
              : `cancel ${args.cancel === true ? "all" : visible(String(args.cancel))}`
            : alarm
              ? `scheduled ${visible(alarm.id)}`
              : phase === "complete"
                ? visible(raw)
                : `schedule ${visible(args.alarm_id ?? "")}`,
        metadata,
        status: failed
          ? "error"
          : phase !== "complete"
            ? phase === "running"
              ? "running"
              : "queued"
            : missing
              ? "warning"
              : "success",
        children,
        defaultOpen: Boolean(failed),
      },
    ],
    theme,
  );
}
