import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ActivityEntry } from "./activity.ts";
import { activityMetricValue } from "./activity-panel-style.ts";
import { render } from "./text.ts";

export const cleanActivityDisplay = (
  value: string,
  multiline = false,
): string =>
  stripVTControlCharacters(
    multiline ? value.slice(-16384) : value.slice(0, 16384),
  )
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(multiline ? /\r/g : /[\r\n]/g, " ");

const primary = {
  shell: ["output_bytes", "exit_code"],
  monitor: [
    "interval_seconds",
    "invocation",
    "phase",
    "next_due_at",
    "last_exit",
  ],
  subagent: ["model", "effort", "turns", "input", "output", "cost"],
};

export function activityDetails(
  entry: ActivityEntry,
  width: number,
  text: Record<string, string>,
  summary: Record<string, string>,
  tail: string,
  level: number,
  theme: Theme,
): string[] {
  const clean = cleanActivityDisplay;
  const metrics = entry.metrics ?? {};
  const snippets = primary[entry.kind].flatMap((key) => {
    const value = metrics[key];
    if (
      value === undefined ||
      value === "" ||
      (key === "next_due_at" && (!value || entry.ended_at))
    )
      return [];
    const display =
      key === "next_due_at" && typeof value === "number"
        ? `${Math.max(0, Math.ceil((value - Date.now()) / 1000))}s`
        : key === "model"
          ? String(value).replace(/^[^/]+\//, "")
          : activityMetricValue(key, value);
    const color =
      key === "model" ? "accent" : key === "cost" ? "success" : "text";
    return [
      theme.fg(
        "muted",
        render(summary[key] ?? "{{value}}", {
          value: theme.bold(theme.fg(color, clean(display))),
        }),
      ),
    ];
  });
  const wrap = (value: string) => wrapTextWithAnsi(value, width).slice(0, 16);
  const separator = theme.fg("dim", " · ");
  const lines = wrap(snippets.join(separator));
  if (entry.log_path)
    lines.push(
      ...wrap(
        theme.fg(
          "muted",
          render(text.log!, {
            value: theme.fg("accent", clean(entry.log_path)),
          }),
        ),
      ),
    );
  lines.push(theme.fg("muted", theme.italic(text.tail!)));
  lines.push(
    ...(tail || text.loading!)
      .trimEnd()
      .split("\n")
      .filter(
        (line) =>
          entry.kind !== "monitor" ||
          (!/^[─═━\-]{6,}$/.test(line.trim()) &&
            !/^(Invocation \d+ —|Command:|Exit:)/.test(line)),
      )
      .slice(-5)
      .map((line) =>
        truncateToWidth(
          theme.fg("dim", "│ ") + theme.fg("muted", clean(line)),
          width,
          "…",
        ),
      ),
  );
  if (level < 2) return lines;
  lines.push(theme.bold(theme.fg("accent", text.more!)));
  for (const [key, value] of [
    ["command", entry.command],
    ["cwd", entry.cwd],
    ["started", new Date(entry.started_at).toISOString()],
    [
      "ended",
      entry.ended_at ? new Date(entry.ended_at).toISOString() : undefined,
    ],
    ["id", entry.id],
  ]) {
    if (value)
      lines.push(
        ...wrap(
          theme.fg(
            "muted",
            render(text[key!]!, {
              value: theme.fg(
                key === "id" || key === "started" || key === "ended"
                  ? "dim"
                  : "text",
                clean(value),
              ),
            }),
          ),
        ),
      );
  }
  const pairs = Object.entries(metrics)
    .slice(0, 32)
    .map(([key, value]) =>
      render(text.metric!, {
        key: theme.fg("muted", clean(key.replaceAll("_", " "))),
        value: theme.fg("text", clean(activityMetricValue(key, value))),
      }),
    );
  lines.push(...wrapTextWithAnsi(pairs.join(separator), width).slice(0, 64));
  return lines.slice(0, 120);
}
