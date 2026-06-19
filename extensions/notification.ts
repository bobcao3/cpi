/**
 * Notification renderer owner.
 *
 * The SINGLE extension that owns the notification TUI renderer for the whole
 * process. pi stores message renderers on the *extension instance*
 * (`messageRenderers` Map, transient per load); `getMessageRenderer` resolves
 * by first-match across live instances. Earlier, each sender extension
 * (shell/alarm/hold) registered the renderer itself — redundant, and the
 * contract ("every sender must register the renderer") was backwards: a
 * presentation concern borrowed from senders, robust only by coincidence
 * (identical fns + first-match).
 *
 * Centralizing ownership here:
 *   - decouples rendering from senders (shell/alarm/hold send only);
 *   - makes the renderer present whenever this extension is loaded (always, as
 *     part of the cpi set) — including across redraws of historical
 *     notifications after a *sender* hot-reload;
 *   - self-heals on this extension's own reload (it re-registers at load on its
 *     fresh instance);
 *   - leaves no process-global dedup flag (the prior flag was unsound: it
 *     survived reload while the per-instance Map did not, so re-registration was
 *     skipped and pi fell back to raw `[notification]` + XML).
 *
 * Senders use `sendNotification` from lib/notification.ts; they never register.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerNotificationRenderer } from "./lib/notification.ts";

export default function (pi: ExtensionAPI): void {
  registerNotificationRenderer(pi);
}
