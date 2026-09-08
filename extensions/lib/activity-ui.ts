import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { ActivityKind } from "./activity.ts";
import { showActivityPanel } from "./activity-panel.ts";
import { loadText, textPath } from "./text.ts";

type FocusFooter = (restore: (input?: string) => void) => boolean;
type EditorFactory = NonNullable<
  ReturnType<ExtensionContext["ui"]["getEditorComponent"]>
>;
const global_key = "__cpiActivityPanel";
function panelState(): { pending?: Promise<void> } {
  const global = globalThis as Record<string, unknown>;
  return (global[global_key] ??= {}) as { pending?: Promise<void> };
}

export async function openActivity(
  ctx: ExtensionContext,
  kind?: ActivityKind,
): Promise<void> {
  const state = panelState();
  if (state.pending) return;
  const pending = showActivityPanel(ctx, kind);
  state.pending = pending;
  try {
    await pending;
  } finally {
    if (state.pending === pending) state.pending = undefined;
  }
}

export function registerActivityBrowser(
  pi: ExtensionAPI,
  focus_footer: FocusFooter,
): void {
  const text = loadText<{
    command: { description: string };
    panel: { not_tui: string };
  }>("activity", textPath("activity"));
  pi.registerCommand("activity", {
    description: text.command.description,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(text.panel.not_tui, "info");
        return;
      }
      await openActivity(ctx);
    },
  });
  let previous: EditorFactory | undefined;
  let installed: EditorFactory | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    previous = ctx.ui.getEditorComponent();
    const base_factory = previous;
    installed = (tui, theme, keybindings) => {
      const editor =
        base_factory?.(tui, theme, keybindings) ??
        new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
      const inspectable = editor as typeof editor &
        Partial<
          Pick<CustomEditor, "getCursor" | "getLines" | "isShowingAutocomplete">
        >;
      if (
        !inspectable.getCursor ||
        !inspectable.getLines ||
        !inspectable.isShowingAutocomplete
      )
        return editor;
      const handle_input = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        if (!matchesKey(data, "down") || inspectable.isShowingAutocomplete!())
          return handle_input(data);
        const before = inspectable.getCursor!();
        const old_text = editor.getText();
        handle_input(data);
        const after = inspectable.getCursor!();
        if (
          before.line !== after.line ||
          before.col !== after.col ||
          old_text !== editor.getText()
        )
          return;
        if (after.line !== inspectable.getLines!().length - 1) return;
        focus_footer((input) => {
          tui.setFocus(editor);
          if (input) handle_input(input);
        });
      };
      return editor;
    };
    ctx.ui.setEditorComponent(installed);
  });
  pi.on("session_shutdown", (_event, ctx) => {
    panelState().pending = undefined;
    if (
      ctx.mode === "tui" &&
      installed &&
      ctx.ui.getEditorComponent() === installed
    )
      ctx.ui.setEditorComponent(previous);
    previous = undefined;
    installed = undefined;
  });
}
