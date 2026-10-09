import {
  CustomEditor,
  formatTokens,
  type FooterContent,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type EditorTheme,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
  compactionTokens,
  setCompactionRender,
} from "./compaction-progress.ts";

export class PromptEditor extends CustomEditor {
  private readonly content: () => FooterContent | undefined;
  private readonly app_theme: () => Theme;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keys: KeybindingsManager,
    content: () => FooterContent | undefined,
    app_theme: () => Theme,
  ) {
    super(tui, theme, keys, { embedWorkingStatus: true });
    this.content = content;
    this.app_theme = app_theme;
    setCompactionRender(() => tui.requestRender());
  }

  private has_notice(): boolean {
    const kind = this.workingStatusIndicator?.kind;
    return !!kind && kind !== "working" && kind !== "compaction";
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    if (this.has_notice())
      lines.unshift(this.workingStatusIndicator!.renderInBorder(width));
    return lines;
  }

  override handleMouse(event: TuiMouseEvent) {
    const offset = this.has_notice() ? 1 : 0;
    if (event.y < offset) return undefined;
    return super.handleMouse({
      ...event,
      y: event.y - offset,
      height: event.height - offset,
    });
  }

  protected override renderTopBorder(
    width: number,
    hiddenLineCount: number,
  ): string {
    const content = this.content();
    if (!content || width < 1)
      return super.renderTopBorder(width, hiddenLineCount);
    const { usage } = content;
    const compacting = this.workingStatusIndicator?.kind === "compaction";
    const status = compacting
      ? `Compacting (${formatTokens(compactionTokens() ?? 0)} tokens)`
      : `↑${formatTokens(usage.input)} ↓${formatTokens(usage.output)} R${formatTokens(usage.cacheRead)}` +
        (usage.cacheWrite ? ` W${formatTokens(usage.cacheWrite)}` : "") +
        ` CH${(content.cacheHitRate ?? 0).toFixed(1)}%`;
    const percent =
      content.contextPercent === null
        ? "?"
        : `${content.contextPercent.toFixed(1)}%`;
    let context = `${percent}/${formatTokens(content.contextWindow)}`;
    if ((content.contextPercent ?? 0) > 70) {
      context = this.app_theme().fg(
        content.contextPercent! > 90 ? "error" : "warning",
        context,
      );
    } else context = this.borderColor(context);
    const spinner =
      this.workingStatusIndicator?.renderSpinnerInBorder(2) ??
      this.borderColor("💤");
    const slot = spinner + " ".repeat(2 - visibleWidth(spinner)) + " ";
    const colored_status = compacting
      ? this.app_theme().fg("muted", status)
      : this.borderColor(status);
    const left = this.borderColor("── ") + slot + colored_status + " ";
    const right = ` ${context} ${this.borderColor("──")}`;
    const right_width = visibleWidth(right);
    if (width < visibleWidth(left) + right_width + 1) {
      const budget = Math.max(0, width - right_width - 1);
      if (budget < 8) return truncateToWidth(left, width, "");
      const clipped = truncateToWidth(left, budget, "…");
      return (
        clipped +
        this.borderColor(
          "─".repeat(width - visibleWidth(clipped) - right_width),
        ) +
        right
      );
    }
    const gap = width - visibleWidth(left) - right_width;
    const overflow = hiddenLineCount ? ` ↑ ${hiddenLineCount} more ` : "";
    const label = overflow && visibleWidth(overflow) + 2 <= gap ? overflow : "";
    const padding = gap - visibleWidth(label);
    return (
      left +
      this.borderColor(
        "─".repeat(Math.floor(padding / 2)) +
          label +
          "─".repeat(Math.ceil(padding / 2)),
      ) +
      right
    );
  }
}
