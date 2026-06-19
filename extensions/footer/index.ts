/**
 * cpi footer owner.
 *
 * Single owner of pi's custom footer across all cpi extensions. Renders
 * line 1 itself (composing branch + segments contributed via
 * `extensions/lib/footer.ts`) and splices lines 2/3 from the built-in
 * FooterComponent. See `extensions/lib/footer.ts` for the architecture.
 *
 * Other cpi extensions must NOT call `ctx.ui.setFooter`; they contribute
 * line-1 data via `setBranchResolver` / `registerLineSegment`, flush-right
 * line-1 indicators via `registerRightSegment`, and line-3 indicators via
 * `ctx.ui.setStatus`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupCpiFooter, disposeCpiFooter } from "../lib/footer.ts";

export default function footerExtension(pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    setupCpiFooter(pi, ctx);
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    setupCpiFooter(pi, ctx);
  });

  pi.on("session_shutdown", async () => {
    disposeCpiFooter();
  });
}
