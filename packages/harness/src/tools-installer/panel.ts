import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type KeybindingsManager,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import { loadText, render, textPath } from "../lib/text.ts";
import {
  inspectManagedTools,
  installManagedTools,
  type InstallProgress,
  type ManagedToolState,
} from "./manager.ts";

export interface ToolsInstallerText {
  command: {
    description: string;
    requires_tui: string;
    requires_idle: string;
  };
  panel: Record<string, string>;
  status: Record<string, string>;
  cli: Record<string, string>;
}

export function loadToolsInstallerText(): ToolsInstallerText {
  return loadText<ToolsInstallerText>(
    "tools-installer",
    textPath("tools-installer"),
  );
}

const statusColor: Record<string, Parameters<Theme["fg"]>[0]> = {
  current: "success",
  update: "warning",
  missing: "muted",
  unsupported: "dim",
  error: "error",
  installing: "accent",
};

function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, width, "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export class ToolsInstallerPanel implements Component, Focusable {
  private tools: ManagedToolState[] = [];
  private selected = 0;
  private offset = 0;
  private busy = false;
  private closed = false;
  private message = "";
  private readonly phases = new Map<string, string>();
  focused = false;

  constructor(
    private readonly options: {
      tui: TUI;
      theme: Theme;
      keybindings: KeybindingsManager;
      cwd: string;
      done: () => void;
      height: () => number;
    },
    private readonly text: ToolsInstallerText = loadToolsInstallerText(),
  ) {
    void this.refresh();
  }

  dispose(): void {
    this.closed = true;
  }

  invalidate(): void {}

  private requestRender(): void {
    if (!this.closed) this.options.tui.requestRender();
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.message = this.text.panel.checking;
    this.requestRender();
    try {
      this.tools = await inspectManagedTools(this.options.cwd);
      this.selected = Math.min(
        this.selected,
        Math.max(0, this.tools.length - 1),
      );
      const failed = this.tools.find((tool) => tool.status === "error");
      this.message = failed?.detail
        ? failed.detail
        : this.tools.some((tool) => tool.status === "update")
          ? ""
          : this.tools.some((tool) => tool.status === "missing")
            ? this.text.panel.ready_missing
            : this.text.panel.ready;
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
      this.requestRender();
    }
  }

  private progress(event: InstallProgress): void {
    for (const id of event.ids) {
      if (event.phase === "installing") this.phases.set(id, "installing");
      else this.phases.delete(id);
    }
    const tool = event.ids.join(", ");
    this.message = render(
      this.text.panel[
        event.phase === "installing"
          ? "installing"
          : event.phase === "complete"
            ? "installed"
            : "failed"
      ],
      { tool, error: event.error ?? "" },
    );
    this.requestRender();
  }

  private async install(ids: string[]): Promise<void> {
    if (this.busy || ids.length === 0) return;
    this.busy = true;
    try {
      this.tools = await installManagedTools(ids, this.options.cwd, (event) =>
        this.progress(event),
      );
    } catch (error) {
      this.message = error instanceof Error ? error.message : String(error);
    } finally {
      this.phases.clear();
      this.busy = false;
      this.requestRender();
    }
  }

  private move(delta: number): void {
    if (!this.tools.length) return;
    this.selected =
      (this.selected + delta + this.tools.length) % this.tools.length;
    this.requestRender();
  }

  handleInput(data: string): void {
    const keys = this.options.keybindings;
    if (keys.matches(data, "tui.select.cancel") || data === "q") {
      this.closed = true;
      this.options.done();
    } else if (keys.matches(data, "tui.select.up")) this.move(-1);
    else if (keys.matches(data, "tui.select.down")) this.move(1);
    else if (
      keys.matches(data, "tui.select.confirm") ||
      data === "i" ||
      data === "u"
    ) {
      const id = this.tools[this.selected]?.id;
      if (id) void this.install([id]);
    } else if (data === "U") {
      const ids = this.tools
        .filter((tool) => tool.status === "update")
        .map((tool) => tool.id);
      if (ids.length) void this.install(ids);
      else {
        this.message = this.text.panel.empty_updates;
        this.requestRender();
      }
    } else if (data === "c") void this.refresh();
  }

  private row(tool: ManagedToolState, index: number, width: number): string {
    const phase = this.phases.get(tool.id);
    const status = phase ?? tool.status;
    const statusText = this.text.status[status] ?? status;
    const color = statusColor[status] ?? "text";
    const installed = tool.installed ?? "—";
    const selected = index === this.selected;
    const prefix = selected ? "› " : "  ";
    let value: string;
    if (width >= 67) {
      value = `${prefix}${pad(statusText, 13)}${pad(tool.label, 31)}${pad(installed, 29)}${tool.desired}`;
    } else {
      value = `${prefix}${statusText}  ${tool.label}  ${installed} → ${tool.desired}`;
    }
    value = truncateToWidth(value, width, "");
    return selected
      ? this.options.theme.bold(this.options.theme.fg("accent", value))
      : this.options.theme.fg(color, value);
  }

  render(width: number): string[] {
    const outer = Math.max(4, width);
    const inner = Math.max(2, outer - 2);
    const viewport = Math.max(
      1,
      Math.min(this.tools.length || 1, this.options.height() - 8),
    );
    if (this.selected < this.offset) this.offset = this.selected;
    if (this.selected >= this.offset + viewport)
      this.offset = this.selected - viewport + 1;
    const border = (left: string, fill: string, right: string) =>
      this.options.theme.fg("border", left + fill.repeat(inner) + right);
    const line = (value: string) =>
      `${this.options.theme.fg("border", "│")}${pad(value, inner)}${this.options.theme.fg("border", "│")}`;
    const rows = this.tools.length
      ? this.tools
          .slice(this.offset, this.offset + viewport)
          .map((tool, index) => this.row(tool, this.offset + index, inner))
      : [this.options.theme.fg("muted", this.text.panel.checking)];
    return [
      border("╭", "─", "╮"),
      line(
        this.options.theme.bold(
          this.options.theme.fg("accent", this.text.panel.title),
        ),
      ),
      line(this.options.theme.fg("muted", this.text.panel.subtitle)),
      ...(outer >= 67
        ? [line(this.options.theme.fg("dim", this.text.panel.columns))]
        : []),
      ...rows.map(line),
      line(this.options.theme.fg("muted", this.message)),
      line(
        this.options.theme.fg(
          "dim",
          inner < 82 ? this.text.panel.help_compact : this.text.panel.help,
        ),
      ),
      border("╰", "─", "╯"),
    ];
  }
}
