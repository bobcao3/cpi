import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function frameActivity(
  lines: string[],
  width: number,
  theme: Theme,
): string[] {
  if (width < 3) return lines.map((line) => truncateToWidth(line, width, ""));
  return lines.map((line, index) => {
    const edge = index === 0 || index === lines.length - 1;
    const room = Math.max(0, width - (edge ? 4 : 2));
    const content = truncateToWidth(line, room, "");
    const fill = Math.max(0, room - visibleWidth(content));
    const border = (text: string) => theme.fg("borderAccent", text);
    const framed = edge
      ? border(index === 0 ? "╭ " : "╰ ") +
        content +
        border(
          (fill ? " " + "─".repeat(fill - 1) : "") +
            (index === 0 ? " ╮" : " ╯"),
        )
      : border("│") + content + " ".repeat(fill) + border("│");
    return theme.bg("userMessageBg", truncateToWidth(framed, width, ""));
  });
}

export function activityDetail(
  text: string,
  width: number,
  theme: Theme,
): string {
  const content = truncateToWidth(`  ${text}`, width, "");
  return theme.bg(
    "customMessageBg",
    content + " ".repeat(Math.max(0, width - visibleWidth(content))),
  );
}

export function activityMetricValue(
  key: string,
  value: string | number,
): string {
  if (typeof value !== "number") return value;
  if (key.endsWith("_at") && value > 0)
    return new Date(value)
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, "Z");
  if (key === "cost") return `$${value.toFixed(4)}`;
  if (key.includes("bytes"))
    return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KiB`;
  return String(value);
}

export function activityHelp(text: string, theme: Theme): string {
  return text
    .split(/(Esc|Enter|←→|Ctrl\+↑↓|↑↓|wheel)/g)
    .map((part, index) =>
      index % 2
        ? theme.bold(theme.fg(part === "Enter" ? "accent" : "muted", part))
        : theme.fg("dim", part),
    )
    .join("");
}
