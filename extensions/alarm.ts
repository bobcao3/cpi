/**
 * Alarm extension
 *
 * Registers an `alarm` tool that schedules a one-shot wake-up message for the
 * model at a future time. Accept either:
 *   - relative_seconds: seconds from now
 *   - target_time: absolute target as ISO 8601 or Unix epoch seconds
 *
 * When the alarm fires, a custom `alarm` message is delivered as a steer so the
 * model wakes up and responds. Alarm state is stored in tool result details and
 * reconstructed on session start / tree navigation.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";
import { sendNotification } from "./lib/notification.ts";
import { registerHoldSource } from "./lib/session-hold.ts";

const ALARM_TOOL = "alarm";
const MAX_ALARM_SECONDS = 365 * 24 * 60 * 60; // ~1 year

interface Alarm {
  id: string;
  targetMs: number;
  message: string;
  fired: boolean;
}

interface AlarmDetails {
  alarms: Alarm[];
}

const alarmSchema = Type.Object({
  relative_seconds: Type.Optional(
    Type.Number({
      description: "Seconds from now for the alarm to fire",
      minimum: 1,
      maximum: MAX_ALARM_SECONDS,
    }),
  ),
  target_time: Type.Optional(
    Type.String({
      description: "Absolute target time as ISO 8601 string or Unix epoch seconds",
    }),
  ),
  message: Type.Optional(
    Type.String({ description: "Custom message to include when the alarm fires" }),
  ),
  alarm_id: Type.Optional(
    Type.String({
      description: "Optional stable id for the alarm; replaces any existing alarm with the same id",
    }),
  ),
  cancel: Type.Optional(
    Type.Union([
      Type.Boolean({ description: "Cancel all active alarms" }),
      Type.String({ description: "Cancel the alarm with this id" }),
    ]),
  ),
});

let piRef: ExtensionAPI;
let alarms: Alarm[] = [];
const timers = new Map<string, NodeJS.Timeout>();

function nextAlarmId(): string {
  let max = 0;
  for (const a of alarms) {
    const m = /^a(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `a${max + 1}`;
}

// Compact date for LLM consumption — omits year, timezone, and milliseconds
// to reduce token count vs full ISO 8601 (e.g. "6/17 17:19:15" ≈ 12 tokens
// vs "2026-06-17T17:19:15.000Z" ≈ 15 tokens). Seconds only shown when non-zero.
function formatAlarmDate(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours().toString().padStart(2, "0");
  const m = d.getMinutes().toString().padStart(2, "0");
  const s = d.getSeconds();
  const time = s > 0 ? `${h}:${m}:${s.toString().padStart(2, "0")}` : `${h}:${m}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function parseTargetTime(input: string): number | null {
  if (/^\d+$/.test(input.trim())) {
    const epochSec = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(epochSec)) return epochSec * 1000;
    return null;
  }
  const ms = Date.parse(input);
  return Number.isNaN(ms) ? null : ms;
}

function reconstructAlarms(ctx: ExtensionContext): void {
  let fromState: Alarm[] | undefined;
  let fromTool: Alarm[] | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === "alarm-state") {
      const details = entry.data as AlarmDetails | undefined;
      if (details?.alarms) fromState = details.alarms;
      continue;
    }
    if (entry.type !== "message") continue;
    const msg = entry.message;
    if (msg.role !== "toolResult" || msg.toolName !== ALARM_TOOL) continue;
    const details = msg.details as AlarmDetails | undefined;
    if (details?.alarms) fromTool = details.alarms;
  }
  alarms = fromState ?? fromTool ?? [];
}

function persistAlarms(): void {
  piRef.appendEntry("alarm-state", { alarms: [...alarms] } as AlarmDetails);
}

function clearAllTimers(): void {
  for (const timer of timers.values()) {
    clearTimeout(timer);
  }
  timers.clear();
}

function scheduleAlarm(alarm: Alarm): void {
  const existing = timers.get(alarm.id);
  if (existing) clearTimeout(existing);

  if (alarm.fired) return;

  const delayMs = alarm.targetMs - Date.now();
  if (delayMs <= 0) {
    fireAlarm(alarm);
    return;
  }

  const timer = setTimeout(() => fireAlarm(alarm), Math.min(delayMs, MAX_ALARM_SECONDS * 1000));
  timers.set(alarm.id, timer);
}

function fireAlarm(alarm: Alarm): void {
  if (alarm.fired) return;
  alarm.fired = true;
  timers.delete(alarm.id);
  persistAlarms();
  // Compact date in payload (not ISO 8601) to minimize tokens in LLM context
  const summary = `Alarm ${alarm.id} fired at ${formatAlarmDate(alarm.targetMs)}`;
  sendNotification(
    piRef,
    {
      kind: "alarm",
      summary,
      payload: {
        id: alarm.id,
        at: formatAlarmDate(alarm.targetMs),
        msg: alarm.message || "Alarm fired",
      },
    },
    { deliverAs: "steer" },
  );
}

function rescheduleFromState(): void {
  clearAllTimers();
  for (const alarm of alarms) {
    scheduleAlarm(alarm);
  }
}

export default function (pi: ExtensionAPI) {
  piRef = pi;


  pi.registerTool({
    name: ALARM_TOOL,
    label: "Alarm",
    description:
      "Schedule a one-shot alarm to wake the model at a future time, or cancel active alarms. Provide either relative_seconds (seconds from now) or target_time (ISO 8601 or Unix epoch seconds). Pass cancel=true or cancel=<alarm_id> to cancel. When the alarm fires, a notification is sent to wake the model.",
    promptSnippet: "Schedule future wake-up alarms for the model",
    promptGuidelines: [
      "Use alarm when the user wants to be reminded or woken after a delay or at a specific time.",
      "For alarm, provide exactly one of relative_seconds or target_time, not both.",
      "Pass cancel=true to cancel all active alarms, or cancel=<alarm_id> to cancel a specific alarm.",
    ],
    parameters: alarmSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      reconstructAlarms(ctx);

      if (params.cancel !== undefined && params.cancel !== false) {
        if (typeof params.cancel === "string") {
          const before = alarms.length;
          alarms = alarms.filter((a) => a.id !== params.cancel);
          if (alarms.length === before) {
            return {
              content: [{ type: "text", text: `No active alarm ${params.cancel}` }],
              details: { alarms: [...alarms] } satisfies AlarmDetails,
            };
          }
        } else {
          alarms = [];
        }
        clearAllTimers();
        rescheduleFromState();
        persistAlarms();
        return {
          content: [
            {
              type: "text",
              text: `Cancelled alarm(s). Active alarms: ${alarms.length}`,
            },
          ],
          details: { alarms: [...alarms] } satisfies AlarmDetails,
        };
      }

      const hasRelative = params.relative_seconds !== undefined;
      const hasTarget = params.target_time !== undefined;

      if (hasRelative === hasTarget) {
        throw new Error("Provide exactly one of relative_seconds or target_time.");
      }

      let targetMs: number;
      if (hasRelative) {
        targetMs = Date.now() + (params.relative_seconds as number) * 1000;
      } else {
        const parsed = parseTargetTime(params.target_time as string);
        if (parsed === null) {
          throw new Error(`Could not parse target_time: ${params.target_time}`);
        }
        targetMs = parsed;
      }

      if (targetMs <= Date.now()) {
        throw new Error("Target time must be in the future.");
      }

      const id = params.alarm_id?.trim() || nextAlarmId();
      const message = params.message?.trim() || `Alarm ${id} fired`;

      alarms = alarms.filter((a) => a.id !== id);
      const alarm: Alarm = { id, targetMs, message, fired: false };
      alarms.push(alarm);
      scheduleAlarm(alarm);
      persistAlarms();

      return {
        content: [
          {
            type: "text",
            // Compact format (not ISO 8601) to minimize tokens in LLM context
            text: `Alarm ${id} at ${formatAlarmDate(targetMs)}`,
          },
        ],
        details: { alarms: [...alarms] } satisfies AlarmDetails,
      };
    },
    renderResult(result, { expanded: _expanded, isPartial: _isPartial }, theme) {
      const text = result.content[0];
      const raw = text?.type === "text" ? text.text : "";
      // Parse alarm ID from text to look up targetMs in details
      const match = /Alarm (\S+) at /.exec(raw);
      if (match) {
        const id = match[1];
        const details = result.details as AlarmDetails | undefined;
        const alarm = details?.alarms?.find((a) => a.id === id);
        if (alarm) {
          const dt = new Date(alarm.targetMs);
          const absTime = dt.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          });
          const deltaSec = Math.round((alarm.targetMs - Date.now()) / 1000);
          const relTime =
            deltaSec > 0
              ? deltaSec >= 3600
                ? `T+${Math.floor(deltaSec / 3600)}h${Math.floor((deltaSec % 3600) / 60)}m`
                : `T+${deltaSec}s`
              : "passed";
          const t = new Text("", 0, 0);
          t.setText(
            theme.fg("success", "✓") + theme.fg("dim", ` Alarm ${id} · ${absTime} · ${relTime}`),
          );
          return t;
        }
      }
      // Cancel result or unrecognized — show raw text
      const t = new Text("", 0, 0);
      t.setText(theme.fg("success", "✓") + theme.fg("dim", ` ${raw}`));
      return t;
    },
  });

  registerHoldSource({
    id: "alarm",
    hasPending: () => alarms.some((a) => !a.fired),
    noticeText: () =>
      `active alarms: ${alarms
        .filter((a) => !a.fired)
        .map((a) => a.id)
        .join(", ")}`,
    deadlineMs: MAX_ALARM_SECONDS * 1000 + 5000,
    onAbort: clearAllTimers,
  });

  pi.on("session_start", async (_event, ctx) => {
    reconstructAlarms(ctx);
    rescheduleFromState();

    const active = new Set(pi.getActiveTools());
    active.add(ALARM_TOOL);
    pi.setActiveTools(Array.from(active));
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructAlarms(ctx);
    rescheduleFromState();
  });
}
