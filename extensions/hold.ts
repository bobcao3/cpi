/**
 * Session-hold owner extension.
 *
 * The SINGLE extension that owns hold logic for the whole process: it reads
 * registered hold sources (see lib/session-hold.ts) at `agent_end` and
 * `session_shutdown` time and runs ONE await + ONE notice. Centralizing this
 * here avoids the inter-extension conflicts that arise when each hold source
 * (alarm, shell) registers its own `session_shutdown` await — pi runs those
 * handlers SEQUENTIALLY, so independent awaits stack their deadlines and
 * double-hold, and independent `agent_end` notices double-emit.
 *
 * Owns: per-turn tracking reset, stop-reason capture, the single hold notice,
 * the single shutdown await + abort. Sources (alarm, shell) only
 * `registerHoldSource` and own their `onAbort` cleanup (e.g. clear timers,
 * kill backgrounds). Also ensures the shared notification renderer is
 * registered exactly once (idempotent via globalThis flag).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ensureNotificationRenderer } from "./lib/notification.ts";
import {
  consumeHoldNotice,
  getHoldSources,
  getLastStopReason,
  resetHoldTracking,
  setLastStopReason,
  type HoldSource,
} from "./lib/session-hold.ts";

export default function (pi: ExtensionAPI): void {
  ensureNotificationRenderer(pi);

  pi.on("agent_start", () => resetHoldTracking());

  pi.on("agent_end", (event: any, ctx: any) => {
    for (let i = event.messages.length - 1; i >= 0; i--) {
      const m = event.messages[i];
      if (m.role === "assistant") {
        setLastStopReason(m.stopReason);
        break;
      }
    }
    if (ctx.hasUI) return;
    const reason = getLastStopReason();
    if (reason === "error" || reason === "aborted") return;
    const pending = getHoldSources().filter((s) => s.hasPending());
    if (pending.length === 0) return;
    if (!consumeHoldNotice()) return;
    emitHoldNotice(ctx, pending);
  });

  pi.on("session_shutdown", async (event: any, ctx: any) => {
    const reason = getLastStopReason();
    const sources = getHoldSources();
    const abortAll = () => {
      for (const s of sources) {
        try {
          s.onAbort();
        } catch {
          // onAbort is best-effort; never let one failure skip the rest.
        }
      }
    };
    if (ctx.hasUI || event.reason !== "quit" || reason === "error" || reason === "aborted") {
      abortAll();
      return;
    }
    const pending = sources.filter((s) => s.hasPending());
    if (pending.length === 0) {
      abortAll();
      return;
    }
    if (consumeHoldNotice()) emitHoldNotice(ctx, pending);
    const deadline = Date.now() + Math.max(...pending.map((s) => s.deadlineMs));
    await new Promise<void>((resolve) => {
      const check = () => {
        if (Date.now() >= deadline) return resolve();
        const still = sources.some((s) => s.hasPending());
        if (!still && ctx.isIdle()) {
          // Grace beat: confirm no follow-up turn is starting before resolving.
          setTimeout(
            () =>
              sources.some((s) => s.hasPending()) || !ctx.isIdle()
                ? setTimeout(check, 100)
                : resolve(),
            500,
          );
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
    abortAll();
  });
}

function emitHoldNotice(ctx: any, pending: HoldSource[]): void {
  const text = pending
    .map((s) => s.noticeText())
    .filter(Boolean)
    .join(" ; ");
  try {
    process.stderr.write(`[hold] ${text}\n`);
  } catch {
    // stderr writes must never break the hold flow.
  }
  if (ctx.hasUI) ctx.ui.notify(text, "info");
}
