import type {
  ExtensionAPI,
  Theme,
  ReadonlyFooter,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ActivityKind } from "./activity.ts";
import { getSubagentUsage } from "./cost-ledger.ts";
import {
  buildFooterRows,
  type FooterHit,
  type FooterSection,
} from "./footer-rows.ts";

export class FooterNavigation implements Component {
  focused = false;
  private hits: FooterHit[] = [];
  private selected?: ActivityKind;
  private return_focus?: (input?: string) => void;
  private tui: TUI;
  private theme: Theme;
  private footer: ReadonlyFooter;
  private sections: () => FooterSection[];
  private open: (kind: ActivityKind) => void;
  private thinking_level: ExtensionAPI["getThinkingLevel"];

  constructor(
    tui: TUI,
    theme: Theme,
    footer: ReadonlyFooter,
    sections: () => FooterSection[],
    open: (kind: ActivityKind) => void,
    thinking_level: ExtensionAPI["getThinkingLevel"],
  ) {
    this.tui = tui;
    this.theme = theme;
    this.footer = footer;
    this.sections = sections;
    this.open = open;
    this.thinking_level = thinking_level;
  }

  focus(return_focus: (input?: string) => void): boolean {
    this.render(this.tui.terminal.columns);
    if (!this.hits.length) return false;
    this.return_focus = return_focus;
    this.selected = this.hits[0].kind;
    this.tui.setFocus(this);
    this.tui.requestRender();
    return true;
  }

  private restore(input?: string): void {
    this.return_focus?.(input);
    this.return_focus = undefined;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    const index = Math.max(
      0,
      this.hits.findIndex((hit) => hit.kind === this.selected),
    );
    if (matchesKey(data, "escape") || matchesKey(data, "up"))
      return this.restore();
    if (matchesKey(data, "enter") || matchesKey(data, "down") || data === " ") {
      const target = this.hits[index]?.kind;
      this.restore();
      if (target) this.open(target);
      return;
    }
    const forward = matchesKey(data, "right") || matchesKey(data, "tab");
    const backward = matchesKey(data, "left") || matchesKey(data, "shift+tab");
    if ((forward || backward) && this.hits.length) {
      this.selected =
        this.hits[
          (index + (forward ? 1 : -1) + this.hits.length) % this.hits.length
        ].kind;
      this.tui.requestRender();
      return;
    }
    this.restore(data);
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.button !== "left") return undefined;
    const hit = this.hits.find(
      (target) =>
        event.y === target.row &&
        event.x >= target.start &&
        event.x < target.end,
    );
    if (!hit) return undefined;
    if (event.type === "click" && this.focused) this.restore();
    return hit.region.handleMouse({
      ...event,
      x: event.x - hit.start,
      y: 0,
      width: hit.end - hit.start,
      height: 1,
    });
  }

  render(width: number): string[] {
    if (width < 1) {
      this.hits = [];
      return ["", "", ""];
    }
    const content = this.footer.getContent();
    const content_sections = this.sections();
    const summary =
      content_sections.find(
        (section) => section.name.toLowerCase() === "summary",
      )?.value ?? "";
    const sections = content_sections.filter(
      (section) => !["summary", "usage"].includes(section.name.toLowerCase()),
    );
    const status_width = Math.min(
      Math.floor(width / 2),
      sections.reduce(
        (sum, section) => sum + visibleWidth(section.value) + 3,
        -1,
      ),
    );
    const rows = buildFooterRows(
      Math.max(1, status_width),
      this.theme,
      sections,
      this.focused ? this.selected : undefined,
      this.open,
    );
    const statuses = rows.component.render(Math.max(1, status_width))[0] ?? "";
    const offset = width - visibleWidth(statuses);
    this.hits = rows.hits.map((hit) => ({
      ...hit,
      start: hit.start + offset,
      end: hit.end + offset,
    }));
    if (this.focused && !this.hits.some((hit) => hit.kind === this.selected)) {
      this.selected = this.hits[0]?.kind;
    }
    const project = truncateToWidth(
      this.theme.fg("dim", content.project),
      Math.max(0, offset - (statuses ? 2 : 0)),
      "…",
    );
    const subagent_cost = getSubagentUsage().cost;
    const cost = `$${(content.usage.cost + subagent_cost).toFixed(4)} (Subagents: $${subagent_cost.toFixed(4)})`;
    const provider =
      content_sections.find((section) => section.name.toLowerCase() === "usage")
        ?.value ??
      (content.provider ? this.theme.fg("dim", content.provider) : "");
    let model = `${content.model}${content.thinkingLevel ? ` • ${content.thinkingLevel}` : ""}`;
    if (content.routedModel) {
      const routed = content.routedModel;
      model += ` → ${routed.id}${routed.thinkingLevel ? ` • ${routed.thinkingLevel}` : ""}`;
    }
    if (content.experimental) model += " • xp";
    const model_text = truncateToWidth(
      this.theme.fg("dim", model),
      Math.max(0, width - Math.min(12, Math.ceil(width * 0.4)) - 1),
      "…",
    );
    const usage_text = truncateToWidth(
      this.theme.fg("dim", cost) +
        (provider ? this.theme.fg("dim", " • ") + provider : ""),
      Math.max(0, width - visibleWidth(model_text) - 1),
      "…",
    );
    return [
      project + " ".repeat(offset - visibleWidth(project)) + statuses,
      usage_text +
        " ".repeat(
          width - visibleWidth(usage_text) - visibleWidth(model_text),
        ) +
        model_text,
      truncateToWidth(
        this.theme.getThinkingBorderColor(this.thinking_level())(
          summary.replace(/[\r\n\t]/g, " "),
        ),
        width,
        "…",
      ),
    ];
  }

  invalidate(): void {
    this.footer.invalidate();
  }
}
