import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadText, textPath } from "../lib/text.ts";
import { isKeyRelease } from "@earendil-works/pi-tui";
import { matchesTreeKey } from "../tree/keybindings.ts";
import { collapseRecentTree } from "../tree/tree-view-collapse.ts";
import { presentationState, resetToolTreePresentation } from "./registry.ts";
import { ToolInspector, type ToolInspectorText } from "./tool-inspector.ts";

export function registerToolInspector(pi: ExtensionAPI): void {
  resetToolTreePresentation();
  let removeInput: (() => void) | undefined;
  const text = loadText<ToolInspectorText>(
    "tool-inspector",
    textPath("tool-inspector"),
  );
  const open = async (ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI || presentationState.closeInspector) return;
    const current = loadText<ToolInspectorText>(
      "tool-inspector",
      textPath("tool-inspector"),
      ctx.cwd,
    );
    let close: (() => void) | undefined;
    try {
      await ctx.ui.custom<void>((ui, _theme, keybindings, done) => {
        const inspector = new ToolInspector(ui, keybindings, current, done);
        close = () => inspector.close();
        presentationState.closeInspector = close;
        return inspector;
      });
    } finally {
      if (presentationState.closeInspector === close)
        presentationState.closeInspector = undefined;
    }
  };
  pi.registerCommand("inspect-tools", {
    description: text.inspector.description,
    handler: (_args, ctx) => open(ctx),
  });
  if (text.inspector.shortcut)
    pi.registerShortcut(text.inspector.shortcut, {
      description: text.inspector.description,
      handler: open,
    });
  pi.on("session_shutdown", () => {
    removeInput?.();
    resetToolTreePresentation();
  });
  pi.on("session_start", (_event, ctx) => {
    resetToolTreePresentation();
    removeInput?.();
    removeInput = ctx.hasUI
      ? ctx.ui.onTerminalInput((data) => {
          if (
            !presentationState.closeInspector &&
            !isKeyRelease(data) &&
            matchesTreeKey(data, "collapseLarge") &&
            collapseRecentTree()
          )
            return { consume: true };
          return undefined;
        })
      : undefined;
  });
  pi.on("session_tree", () => resetToolTreePresentation());
}
