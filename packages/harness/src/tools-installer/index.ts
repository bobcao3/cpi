import {
  getAgentDir,
  getThemeByName,
  initTheme,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  KeybindingsManager,
  ProcessTerminal,
  TUI_KEYBINDINGS,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { ToolsInstallerPanel } from "./panel.ts";

export * from "./manager.ts";
export { loadToolsInstallerText } from "./panel.ts";

export async function showToolsInstaller(ctx: ExtensionContext): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, keybindings, done) =>
      new ToolsInstallerPanel({
        tui,
        theme,
        keybindings,
        cwd: ctx.cwd,
        done: () => done(),
        height: () => tui.terminal.rows,
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "90%",
        maxHeight: "85%",
        margin: 1,
      },
    },
  );
}

export async function runToolsInstallerTui(
  cwd: string = process.cwd(),
): Promise<void> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir);
  const themeName = settings.getTheme();
  initTheme(themeName);
  const theme = getThemeByName(themeName ?? "system");
  if (!theme) throw new Error("unable to initialize tools installer theme");
  const tui = new TuiMainScreen(
    new ProcessTerminal(),
    settings.getShowHardwareCursor(),
    agentDir,
  );
  tui.setClearOnShrink(settings.getClearOnShrink());
  await new Promise<void>((resolve) => {
    const panel = new ToolsInstallerPanel({
      tui,
      theme,
      keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
      cwd,
      done: () => {
        tui.stop();
        resolve();
      },
      height: () => tui.terminal.rows,
    });
    tui.addChild(panel);
    tui.setFocus(panel);
    tui.start();
  });
}
