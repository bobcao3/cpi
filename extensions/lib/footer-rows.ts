import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ActivityKind } from "./activity.ts";

export interface FooterSection {
  name: string;
  value: string;
}
export interface FooterHit {
  kind: ActivityKind;
  row: number;
  start: number;
  end: number;
}

const priorities = ["branch", "fast", "codex", "shell", "subagent-cost"];
const priority = (name: string) => {
  if (name === "jj") return 0;
  if (name === "summary") return 6;
  const index = priorities.indexOf(name);
  return index < 0 ? 5 : index;
};

function separator(theme: Theme): string {
  const match = theme
    .getBgAnsi("customMessageBg")
    .match(/\x1b\[48;2;(\d+);(\d+);(\d+)m/);
  if (!match) return theme.bg("toolPendingBg", " ");
  const rgb = match
    .slice(1)
    .map((channel) => Math.round(Number(channel) * 0.55));
  return `\x1b[48;2;${rgb.join(";")}m \x1b[49m`;
}

function tokens(section: FooterSection) {
  if (section.name === "subagent-cost")
    return [
      {
        kind: "subagent" as const,
        index: 0,
        text: section.value,
        active: /sub:[1-9]/.test(section.value),
      },
    ];
  if (section.name !== "shell") return [];
  return [...section.value.matchAll(/\b(bg|mon):(\d+)\b/g)].map((match) => ({
    kind: match[1] === "bg" ? ("shell" as const) : ("monitor" as const),
    index: match.index!,
    text: match[0],
    active: Number(match[2]) > 0,
  }));
}

export function renderFooterRows(
  width: number,
  theme: Theme,
  input: FooterSection[],
  selected?: ActivityKind,
): { lines: string[]; hits: FooterHit[] } {
  const sections = [...input].sort(
    (a, b) => priority(a.name.toLowerCase()) - priority(b.name.toLowerCase()),
  );
  const total = sections.reduce(
    (sum, section) => sum + visibleWidth(section.value) + 3,
    -1,
  );
  const summary = sections.find(
    (section) => section.name.toLowerCase() === "summary",
  );
  const rows =
    total > width && summary
      ? [sections.filter((section) => section !== summary), [summary]].filter(
          (row) => row.length,
        )
      : [sections];
  const hits: FooterHit[] = [];
  const lines = rows
    .filter((row) => row.length)
    .map((row, row_index) => {
      let column = 0;
      const pieces = row.map((section) => {
        let position = 0;
        let value = "";
        for (const token of tokens(section)) {
          const start =
            column + 1 + visibleWidth(section.value.slice(0, token.index));
          const end = start + visibleWidth(token.text);
          const visible = end <= width - (total > width && !summary ? 1 : 0);
          if (visible)
            hits.push({ kind: token.kind, row: row_index, start, end });
          value += theme.fg(
            "muted",
            section.value.slice(position, token.index),
          );
          const foreground = theme.fg(
            token.active ? "success" : "muted",
            token.text,
          );
          value +=
            visible && selected === token.kind
              ? theme.bg(
                  "selectedBg",
                  theme.bold(theme.fg("accent", token.text)),
                )
              : foreground;
          position = token.index + token.text.length;
        }
        value += theme.fg("muted", section.value.slice(position));
        column += visibleWidth(section.value) + 3;
        return theme.bg("customMessageBg", ` ${value} `);
      });
      return truncateToWidth(pieces.join(separator(theme)), width);
    });
  return { lines, hits };
}
