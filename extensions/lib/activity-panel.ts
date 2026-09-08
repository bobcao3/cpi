import { access } from "node:fs/promises";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import {
  listActivities,
  readActivityTail,
  type ActivityEntry,
  type ActivityKind,
} from "./activity.ts";
import { loadText, render, textPath } from "./text.ts";
import { frameActivity, activityHelp } from "./activity-panel-style.ts";
import {
  activityDetails,
  cleanActivityDisplay as clean,
} from "./activity-details.ts";

type ActivityText = {
  panel: Record<string, string>;
  summary: Record<string, string>;
  tabs: Record<string, string>;
  status: Record<ActivityEntry["status"], string>;
};
const kinds: (ActivityKind | undefined)[] = [
  undefined,
  "shell",
  "monitor",
  "subagent",
];
const live = (entry: ActivityEntry) =>
  entry.status === "running" || entry.status === "stopping";
const age = (entry: ActivityEntry) => {
  const seconds = Math.max(
    0,
    Math.floor(((entry.ended_at ?? Date.now()) - entry.started_at) / 1000),
  );
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
};

export class ActivityPanel implements Component {
  private readonly text = loadText<ActivityText>(
    "activity",
    textPath("activity"),
  );
  private entries: ActivityEntry[] = [];
  private selected_id?: string;
  private expanded_id?: string;
  private detail_level = 0;
  private tab: number;
  private offset = 0;
  private detail_offset = 0;
  private detail_count = 0;
  private viewport = 1;
  private row_ids: (string | undefined)[] = [];
  private tab_regions: { start: number; end: number; index: number }[] = [];
  private tail = "";
  private generation = 0;
  private reading = false;
  private settled_key?: string;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly options: {
      session_id?: string;
      kind?: ActivityKind;
      theme: Theme;
      height: () => number;
      requestRender: () => void;
      done: () => void;
    },
  ) {
    this.tab = Math.max(0, kinds.indexOf(options.kind));
    this.refresh();
    this.timer = setInterval(() => this.refresh(), 1000);
  }

  dispose(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.generation++;
    this.entries = [];
    this.tail = "";
    this.row_ids = [];
  }

  invalidate(): void {}

  private refresh(): void {
    if (this.closed) return;
    const kind = kinds[this.tab];
    this.entries = listActivities(this.options.session_id)
      .filter((entry) => !kind || entry.kind === kind)
      .sort(
        (a, b) =>
          Number(live(b)) - Number(live(a)) ||
          (live(a)
            ? a.started_at - b.started_at
            : (b.ended_at ?? b.started_at) - (a.ended_at ?? a.started_at)),
      )
      .slice(0, 1000);
    if (!this.entries.some((entry) => entry.id === this.selected_id))
      this.select(this.entries[0]?.id);
    void this.read_tail();
    this.options.requestRender();
  }

  private select(id: string | undefined): void {
    if (this.selected_id === id) return;
    this.selected_id = id;
    this.expanded_id = undefined;
    this.detail_level = 0;
    this.reset_tail();
  }

  private reset_tail(): void {
    this.generation++;
    this.detail_offset = 0;
    this.tail = "";
    this.settled_key = undefined;
  }

  private async read_tail(): Promise<void> {
    const entry = this.entries.find((item) => item.id === this.expanded_id);
    if (!entry || this.reading || this.closed) return;
    const key = JSON.stringify([
      entry.id,
      entry.log_path,
      entry.status,
      entry.tail,
    ]);
    if (key === this.settled_key) return;
    const generation = this.generation;
    this.reading = true;
    let settled = !live(entry);
    let tail: string;
    try {
      if (entry.log_path) await access(entry.log_path);
      if (!entry.log_path && !entry.tail) {
        tail = this.text.panel.no_log!;
        settled = true;
      } else
        tail =
          clean(await readActivityTail(entry), true) ||
          this.text.panel.no_output!;
    } catch {
      tail = entry.tail
        ? clean(entry.tail, true)
        : this.text.panel.missing_log!;
      settled = true;
    } finally {
      this.reading = false;
    }
    if (this.closed || generation !== this.generation) return;
    this.tail = tail;
    if (settled) this.settled_key = key;
    this.options.requestRender();
  }

  private filter(index: number): void {
    this.tab = (index + kinds.length) % kinds.length;
    this.offset = 0;
    this.refresh();
  }

  private move(delta: number): void {
    const index = Math.max(
      0,
      this.entries.findIndex((entry) => entry.id === this.selected_id),
    );
    this.select(
      this.entries[
        Math.max(0, Math.min(this.entries.length - 1, index + delta))
      ]?.id,
    );
    this.options.requestRender();
  }

  private scroll_details(delta: number): void {
    if (this.expanded_id) {
      this.detail_offset = Math.max(
        0,
        Math.min(
          Math.max(0, this.detail_count - Math.max(1, this.viewport - 1)),
          this.detail_offset + delta,
        ),
      );
      this.options.requestRender();
    } else this.move(delta);
  }

  private toggle(): void {
    this.detail_level = (this.detail_level + 1) % 3;
    this.expanded_id = this.detail_level ? this.selected_id : undefined;
    if (this.detail_level < 2) this.reset_tail();
    else this.detail_offset = 0;
    void this.read_tail();
    this.options.requestRender();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (matchesKey(data, "escape")) {
      this.dispose();
      this.options.done();
    } else if (matchesKey(data, "left") || matchesKey(data, "shift+tab"))
      this.filter(this.tab - 1);
    else if (matchesKey(data, "right") || matchesKey(data, "tab"))
      this.filter(this.tab + 1);
    else if (matchesKey(data, "ctrl+up")) this.scroll_details(-1);
    else if (matchesKey(data, "ctrl+down")) this.scroll_details(1);
    else if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "pageUp")) this.move(-this.viewport);
    else if (matchesKey(data, "pageDown")) this.move(this.viewport);
    else if (matchesKey(data, "home")) this.move(-this.entries.length);
    else if (matchesKey(data, "end")) this.move(this.entries.length);
    else if (matchesKey(data, "enter") || matchesKey(data, "space"))
      this.toggle();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.closed) return undefined;
    if (event.type === "wheel" && event.wheelDelta) {
      const delta = event.wheelDelta < 0 ? -1 : 1;
      this.scroll_details(delta);
      return { handled: true, render: true };
    }
    if (event.button !== "left") return undefined;
    if (event.type === "press") return { handled: true };
    if (event.type !== "click") return undefined;
    if (event.y === 1) {
      const tab = this.tab_regions.find(
        (region) => event.x - 1 >= region.start && event.x - 1 < region.end,
      );
      if (tab) this.filter(tab.index);
    } else {
      const id = this.row_ids[event.y - 2];
      if (id) {
        this.select(id);
        this.toggle();
      }
    }
    return { handled: true, render: true };
  }

  private details(entry: ActivityEntry, width: number): string[] {
    return activityDetails(
      entry,
      width,
      this.text.panel,
      this.text.summary,
      this.tail,
      this.detail_level,
      this.options.theme,
    );
  }

  render(outer_width: number): string[] {
    if (outer_width < 1 || this.closed) return [];
    const width = Math.max(1, outer_width - 2);
    const height = Math.max(
      1,
      Math.min(
        Math.floor(this.options.height() * 0.8),
        this.options.height() - 6,
      ),
    );
    this.viewport = Math.max(1, height - 3);
    const theme = this.options.theme;
    const clip = (text: string) => truncateToWidth(text, width, "");
    let tabs = "";
    this.tab_regions = kinds.map((kind, index) => {
      const start = visibleWidth(tabs);
      const label = ` ${clean(this.text.tabs[kind ?? "all"]!)} `;
      tabs +=
        index === this.tab
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : theme.fg("muted", ` ${label} `);
      return { start, end: Math.min(width, visibleWidth(tabs)), index };
    });
    const rows: { text: string; id: string }[] = [];
    let selected_start = 0;
    let selected_end = 0;
    for (const entry of this.entries) {
      const selected = entry.id === this.selected_id;
      if (selected) selected_start = rows.length;
      const color =
        entry.status === "failed"
          ? "error"
          : live(entry)
            ? "success"
            : entry.status === "cancelled"
              ? "warning"
              : "muted";
      const label = [
        theme.fg("accent", selected ? "›" : " "),
        theme.fg(color, clean(this.text.status[entry.status])),
        theme.bold(theme.fg("text", clean(entry.label))),
        theme.fg("dim", "·"),
        theme.fg("muted", clean(this.text.tabs[entry.kind]!)),
        theme.fg("dim", age(entry)),
      ].join(" ");
      const styled = clip(label);
      rows.push({
        text: selected
          ? theme.bg(
              "selectedBg",
              styled + " ".repeat(Math.max(0, width - visibleWidth(label))),
            )
          : styled,
        id: entry.id,
      });
      if (selected && this.expanded_id === entry.id) {
        const details = this.details(entry, Math.max(1, width - 2));
        this.detail_count = details.length;
        this.detail_offset = Math.min(
          this.detail_offset,
          Math.max(0, details.length - Math.max(1, this.viewport - 1)),
        );
        for (const detail of details.slice(
          this.detail_offset,
          this.detail_offset + this.viewport - 1,
        ))
          rows.push({ text: clip(`  ${detail}`), id: entry.id });
      }
      if (selected) selected_end = rows.length;
    }
    this.offset = Math.max(
      0,
      Math.min(this.offset, rows.length - this.viewport),
    );
    if (selected_start < this.offset) this.offset = selected_start;
    if (selected_end > this.offset + this.viewport)
      this.offset = selected_end - this.viewport;
    const visible = rows.slice(this.offset, this.offset + this.viewport);
    this.row_ids = visible.map((row) => row.id);
    const position = render(this.text.panel.position!, {
      selected:
        this.entries.findIndex((entry) => entry.id === this.selected_id) + 1,
      total: this.entries.length,
    });
    return frameActivity(
      [
        clip(
          theme.bold(theme.fg("accent", clean(this.text.panel.title!))) +
            theme.fg("dim", ` · ${position}`),
        ),
        clip(tabs),
        ...visible.map((row) => row.text),
        ...(rows.length ? [] : [clip(clean(this.text.panel.empty!))]),
        clip(
          activityHelp(
            clean(
              render(this.text.panel.help!, {
                action:
                  this.text.panel[
                    this.detail_level === 0
                      ? "expand"
                      : this.detail_level === 1
                        ? "deeper"
                        : "collapse"
                  ],
              }),
            ),
            theme,
          ),
        ),
      ].slice(0, height),
      outer_width,
      theme,
    );
  }
}

export async function showActivityPanel(
  ctx: ExtensionContext,
  kind: ActivityKind | undefined,
): Promise<void> {
  if (ctx.mode !== "tui" || !ctx.hasUI) return;
  await ctx.ui.custom<void>(
    (tui, theme, _keys, done) =>
      new ActivityPanel({
        session_id: ctx.sessionManager.getSessionId(),
        kind,
        theme,
        height: () => tui.terminal.rows,
        requestRender: () => tui.requestRender(),
        done: () => done(),
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "90%",
        maxHeight: "80%",
        margin: { top: 1, bottom: 5, left: 1, right: 1 },
      },
    },
  );
}
