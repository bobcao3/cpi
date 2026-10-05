import { randomUUID } from "node:crypto";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { sendNotification, type NotificationDetails } from "./notification.ts";
import { registerHoldSource, signalHoldEvent } from "./session-hold.ts";

export const EVENT_SOURCE_CHANNEL = "cpi:register-event-source:v1";
export const EVENT_SOURCE_LIMITS = {
  sources: 32,
  queued: 64,
  summaryChars: 1024,
  dataBytes: 16384,
  dataNodes: 1024,
  shutdownMs: 5 * 60 * 1000,
} as const;

export interface EventSourceHandle {
  notify: (summary: string, data: Record<string, unknown>) => boolean;
  changed: () => void;
  dispose: () => void;
}

export interface EventSourceRequest {
  id: string;
  hasPending: () => boolean;
  noticeText: () => string;
  onAbort: () => void;
  reply: (handle: EventSourceHandle) => void;
}

function encodeData(data: Record<string, unknown>): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  let nodes = 0;
  try {
    const json = JSON.stringify(data, (_key, value) => {
      if (
        ++nodes > EVENT_SOURCE_LIMITS.dataNodes ||
        (typeof value === "string" &&
          value.length > EVENT_SOURCE_LIMITS.dataBytes) ||
        ["undefined", "function", "symbol", "bigint"].includes(typeof value) ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new Error("Invalid event data");
      return value;
    });
    if (json && Buffer.byteLength(json) <= EVENT_SOURCE_LIMITS.dataBytes)
      return json;
  } catch {}
}

export function registerExternalEvents(pi: ExtensionAPI) {
  const scope = {};
  const sources = new Map<string, () => void>();
  const queued = new Set<string>();
  let active = false;
  let context: ExtensionContext | undefined;
  const current = () => {
    try {
      return active && context?.sessionManager !== undefined;
    } catch {
      return false;
    }
  };
  let abort_signal: AbortSignal | undefined;
  const abortSources = () => {
    for (const dispose of [...sources.values()]) dispose();
  };
  const abort = () => {
    abortSources();
    queued.clear();
  };
  const unbindAbort = () => {
    abort_signal?.removeEventListener("abort", abort);
    abort_signal = undefined;
  };
  const close = () => {
    const wake = current();
    active = false;
    unbindAbort();
    abortSources();
    queued.clear();
    if (wake) signalHoldEvent(scope);
  };
  pi.on("session_start", (_event, ctx) => {
    close();
    context = ctx;
    active = true;
  });
  pi.on("agent_start", (_event, ctx) => {
    unbindAbort();
    abort_signal = ctx.signal;
    if (abort_signal?.aborted) abort();
    else if (sources.size > 0)
      abort_signal?.addEventListener("abort", abort, { once: true });
  });
  pi.on("agent_settled", unbindAbort);
  pi.on("message_start", (event) => {
    const message = event.message;
    if (message.role !== "custom" || message.customType !== "notification")
      return;
    const token = (
      message.details as { externalEventToken?: string } | undefined
    )?.externalEventToken;
    if (token) queued.delete(token);
  });
  pi.events.on(EVENT_SOURCE_CHANNEL, (value) => {
    const request = value as EventSourceRequest | undefined;
    if (
      !current() ||
      abort_signal?.aborted ||
      !request ||
      typeof request.id !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(request.id) ||
      sources.has(request.id) ||
      sources.size >= EVENT_SOURCE_LIMITS.sources ||
      typeof request.hasPending !== "function" ||
      typeof request.noticeText !== "function" ||
      typeof request.onAbort !== "function" ||
      typeof request.reply !== "function"
    )
      return;
    const { id, hasPending, noticeText, onAbort, reply } = request;
    let live = true;
    const dispose = () => {
      if (!live) return;
      live = false;
      sources.delete(id);
      if (sources.size === 0) abort_signal?.removeEventListener("abort", abort);
      unregister();
      try {
        onAbort();
      } catch {}
      if (current()) signalHoldEvent(scope);
    };
    const pending = () => {
      if (!live) return false;
      if (!current()) {
        dispose();
        return false;
      }
      try {
        return hasPending() === true;
      } catch {
        dispose();
        return false;
      }
    };
    const unregister = registerHoldSource({
      id: `external-event:${id}`,
      scope,
      passive: true,
      hasPending: pending,
      noticeText: () => {
        if (!live) return "";
        try {
          return String(noticeText()).slice(
            0,
            EVENT_SOURCE_LIMITS.summaryChars,
          );
        } catch {
          dispose();
          return "";
        }
      },
      deadlineMs: EVENT_SOURCE_LIMITS.shutdownMs,
      onAbort: dispose,
    });
    sources.set(id, dispose);
    abort_signal?.addEventListener("abort", abort, { once: true });
    const handle: EventSourceHandle = {
      notify(summary, data) {
        if (
          !current() ||
          !live ||
          abort_signal?.aborted ||
          queued.size >= EVENT_SOURCE_LIMITS.queued ||
          typeof summary !== "string" ||
          !summary.trim() ||
          summary.length > EVENT_SOURCE_LIMITS.summaryChars
        )
          return false;
        const json = encodeData(data);
        if (
          json === undefined ||
          !current() ||
          !live ||
          abort_signal?.aborted ||
          queued.size >= EVENT_SOURCE_LIMITS.queued
        )
          return false;
        const token = randomUUID();
        const details: NotificationDetails & { externalEventToken: string } = {
          kind: "external-event",
          summary,
          payload: { source: id, summary, data: json },
          externalEventToken: token,
        };
        queued.add(token);
        try {
          sendNotification(pi, details, { deliverAs: "steer" });
        } catch {
          queued.delete(token);
          return false;
        }
        signalHoldEvent(scope);
        return true;
      },
      changed() {
        if (current() && live && !pending()) signalHoldEvent(scope);
      },
      dispose,
    };
    try {
      reply(handle);
    } catch {
      dispose();
    }
  });
  return { scope, hasQueued: () => queued.size > 0, close };
}
