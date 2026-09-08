import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type Component,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { ActivityKind } from "./activity.ts";
import {
  renderFooterRows,
  type FooterHit,
  type FooterSection,
} from "./footer-rows.ts";

export class FooterNavigation implements Component {
  focused = false;
  private hits: FooterHit[] = [];
  private selected?: ActivityKind;
  private footer_height = 0;
  private return_focus?: (input?: string) => void;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private footer: Component,
    private sections: () => FooterSection[],
    private open: (kind: ActivityKind) => void,
  ) {}

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
        event.y === this.footer_height + target.row &&
        event.x >= target.start &&
        event.x < target.end,
    );
    if (!hit) return undefined;
    if (event.type === "press") return { handled: true };
    if (event.type !== "click") return undefined;
    if (this.focused) this.restore();
    this.open(hit.kind);
    return { handled: true };
  }

  render(width: number): string[] {
    const base = this.footer.render(width);
    this.footer_height = base.length;
    const rows = renderFooterRows(
      width,
      this.theme,
      this.sections(),
      this.focused ? this.selected : undefined,
    );
    this.hits = rows.hits;
    if (this.focused && !this.hits.some((hit) => hit.kind === this.selected)) {
      this.selected = this.hits[0]?.kind;
    }
    return [...base, ...rows.lines];
  }

  invalidate(): void {
    this.footer.invalidate();
  }
}
