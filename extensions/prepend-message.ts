/**
 * Prepend-message drain owner.
 *
 * The SINGLE extension that owns the drain handlers for the queued-message
 * plumbing in lib/prepend-message.ts. Producers (e.g. cwd) call `queueMessage()`
 * (lib) to enqueue; this extension wires the two drain points
 * (`before_agent_start` -> drainBeforeUser, `tool_execution_end` ->
 * drainAfterTool) on its own instance at load.
 *
 * Why a dedicated owner, not a globalThis "installed" flag: pi stores event
 * handlers on the *extension instance* (`extension.handlers`, transient per
 * load), so a process-global flag would survive a reload while the handlers
 * did not -> re-installation skipped -> queued messages never drain. Owning
 * the drains in one extension keeps them present whenever this extension is
 * loaded (always, as part of the cpi set) and self-healing on its own reload.
 * Producers enqueue only; they never install handlers. (Same pattern as
 * extensions/notification.ts.) See AGENTS.md -> "Developing extensions".
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { drainAfterTool, drainBeforeUser } from "./lib/prepend-message.ts";

export default function (pi: ExtensionAPI): void {
  pi.on("before_agent_start", () => drainBeforeUser(pi));
  pi.on("tool_execution_end", () => drainAfterTool(pi));
}
