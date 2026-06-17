/**
 * Alarm extension
 *
 * Registers an `alarm` tool that schedules a one-shot wake-up message for the
 * model at a future time. Accept either:
 *   - relative_seconds: seconds from now (T+ time)
 *   - target_time: absolute target as ISO 8601 or Unix epoch seconds
 *
 * When the alarm fires, a custom `alarm` message is delivered as a steer so the
 * model wakes up and responds. Alarm state is stored in tool result details and
 * reconstructed on session start / tree navigation.
 */

import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ALARM_TOOL = "alarm";
const ALARM_MESSAGE_TYPE = "alarm";
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

interface AlarmFiredDetails {
  alarmId: string;
  targetMs: number;
}

const alarmSchema = Type.Object({
  relative_seconds: Type.Optional(
    Type.Number({
      description: "Seconds from now for the alarm to fire (T+ time)",
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
let holdNoticeSent = false;
let lastStopReason: string | undefined;

function generateAlarmId(): string {
  return `alarm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  piRef.sendMessage(
    {
      customType: ALARM_MESSAGE_TYPE,
      content: alarm.message || "⏰ Alarm fired",
      display: true,
      details: { alarmId: alarm.id, targetMs: alarm.targetMs } satisfies AlarmFiredDetails,
    },
    { deliverAs: "steer", triggerTurn: true },
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

  pi.registerMessageRenderer(ALARM_MESSAGE_TYPE, (message, _options, theme) => {
    const details = message.details as AlarmFiredDetails | undefined;
    const id = details?.alarmId ?? "unknown";
    const when = details?.targetMs ? new Date(details.targetMs).toLocaleTimeString() : "unknown";
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(`${theme.fg("toolTitle", "Alarm")}: ${id} fired at ${when}`, 0, 0));
    box.addChild(new Text(theme.fg("muted", message.content), 0, 1));
    return box;
  });

  pi.registerTool({
    name: ALARM_TOOL,
    label: "Alarm",
    description:
      "Schedule a one-shot alarm to wake the model at a future time, or cancel active alarms. Provide either relative_seconds (T+ time) or target_time (ISO 8601 or Unix epoch seconds). Pass cancel=true or cancel=<alarm_id> to cancel. When the alarm fires, a custom message is sent to wake up the model.",
    promptSnippet: "Schedule future wake-up alarms for the model",
    promptGuidelines: [
      "Use alarm when the user wants to be reminded or woken after a delay or at a specific time.",
      "Provide exactly one of relative_seconds or target_time, not both.",
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

      const id = params.alarm_id?.trim() || generateAlarmId();
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
            text: `Scheduled alarm ${id} for ${new Date(targetMs).toISOString()}.`,
          },
        ],
        details: { alarms: [...alarms] } satisfies AlarmDetails,
      };
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    reconstructAlarms(ctx);
    rescheduleFromState();

    // Ensure the alarm tool stays active after other extensions (e.g. shell) mutate the active tool set.
    setTimeout(() => {
      const active = new Set(pi.getActiveTools());
      active.add(ALARM_TOOL);
      pi.setActiveTools(Array.from(active));
    }, 0);
  });

  pi.on("session_tree", async (_event, ctx) => {
    reconstructAlarms(ctx);
    rescheduleFromState();
  });

  const formatActiveAlarms = () => {
    const ids = alarms.filter((a) => !a.fired).map((a) => a.id);
    return `holding, active alarms: ${ids.join(", ")}`;
  };

  const emitHoldMessage = (ctx: ExtensionContext) => {
    const text = formatActiveAlarms();
    // Write to stderr only; do not inject a custom message into the model context.
    process.stderr.write(`[alarm-hold] ${text}\n`);
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
    if (alarms.filter((a) => !a.fired).length === 0) return;

    if (!holdNoticeSent) {
      emitHoldMessage(ctx);
      holdNoticeSent = true;
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // Interactive sessions and non-exit reasons should not hold the process.
    if (ctx.hasUI || event.reason !== "quit") {
      clearAllTimers();
      return;
    }

    const pending = alarms.filter((a) => !a.fired);
    if (pending.length === 0) {
      clearAllTimers();
      return;
    }
    if (lastStopReason === "error" || lastStopReason === "aborted") {
      clearAllTimers();
      return;
    }

    if (!holdNoticeSent) {
      emitHoldMessage(ctx);
      holdNoticeSent = true;
    }

    // Keep the session/runtime alive until all alarms fire and the agent stays idle
    // long enough for any queued follow-up turn to complete.
    await new Promise<void>((resolve) => {
      const pendingCount = () => alarms.filter((a) => !a.fired).length;
      const check = () => {
        if (pendingCount() === 0 && ctx.isIdle()) {
          // Wait a grace beat to confirm no follow-up turn is starting.
          setTimeout(() => {
            if (pendingCount() === 0 && ctx.isIdle()) {
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

    clearAllTimers();
  });
}
