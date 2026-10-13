import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadText, textPath } from "../lib/text.ts";
import { showToolsInstaller } from "./index.ts";
import type { ToolsInstallerText } from "./panel.ts";

export default function toolsInstallerExtension(pi: ExtensionAPI): void {
  const text = loadText<ToolsInstallerText>(
    "tools-installer",
    textPath("tools-installer"),
  );
  pi.registerCommand("toolsInstaller", {
    description: text.command.description,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(text.command.requires_tui, "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(text.command.requires_idle, "warning");
        return;
      }
      await showToolsInstaller(ctx);
    },
  });
}
