import { stripVTControlCharacters } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ActivityEntry } from "./activity.ts";
import { activityMetricValue } from "./activity-panel-style.ts";
import { render } from "./text.ts";
import { highlightCommandSync } from "./tree-sitter.ts";
import { highlightRange, lineBounds } from "../shell/highlight.ts";

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

function shellDetails(
  entry: ActivityEntry,
  width: number,
  text: Record<string, string>,
  summary: Record<string, string>,
  tail: string,
  level: number,
  theme: Theme,
): string[] {
  const lines = [theme.fg("muted", theme.italic(text.shell_tail!))];
  lines.push(
    ...(tail || text.loading!)
      .trimEnd()
      .split("\n")
      .slice(-5)
      .map((line) =>
        truncateToWidth(
          theme.fg("dim", "| ") + theme.fg("muted", cleanActivityDisplay(line)),
          width,
          "…",
        ),
      ),
  );
  if (entry.command) {
    const command = cleanActivityDisplay(entry.command, true).replace(
      /\n$/,
      "",
    );
    const sourceLines = command.split("\n");
    const { starts, ends } = lineBounds(command);
    const captures = highlightCommandSync(command);
    const shown = level < 2 ? 1 : Math.min(sourceLines.length, 32);
    for (let i = 0; i < shown; i++) {
      const code = captures
        ? highlightRange(
            command,
            captures,
            theme,
            starts[i],
            ends[i] - Number(i < sourceLines.length - 1),
          )
        : theme.fg("text", sourceLines[i]);
      const prefix = i === 0 ? text.shell_command! : "  ";
      const remaining = sourceLines.length - shown;
      const suffix =
        i === shown - 1 && remaining > 0
          ? theme.fg(
              "dim",
              render(text.shell_more_lines!, { count: remaining }),
            )
          : "";
      const label = theme.fg("muted", prefix);
      if (level < 2) {
        const room = Math.max(0, width - visibleWidth(label + suffix));
        lines.push(
          truncateToWidth(
            label + truncateToWidth(code, room, "…") + suffix,
            width,
            "…",
          ),
        );
      } else
        lines.push(
          ...wrapTextWithAnsi(label + code + suffix, width).slice(0, 2),
        );
    }
  }
  if (level < 2) {
    lines.push(theme.fg("accent", text.shell_expand!));
    return lines;
  }
  const wrap = (value: string) => wrapTextWithAnsi(value, width).slice(0, 16);
  if (entry.cwd)
    lines.push(
      ...wrap(
        render(text.shell_dir!, {
          value: theme.fg("text", cleanActivityDisplay(entry.cwd)),
        }),
      ),
    );
  lines.push(theme.bold(theme.fg("accent", text.more!)));
  const metrics = entry.metrics ?? {};
  const snippets = primary.shell.flatMap((key) => {
    const value = metrics[key];
    return value === undefined
      ? []
      : [
          render(summary[key] ?? "{{value}}", {
            value: theme.bold(
              theme.fg(
                "text",
                cleanActivityDisplay(activityMetricValue(key, value)),
              ),
            ),
          }),
        ];
  });
  if (snippets.length)
    lines.push(
      ...wrap(theme.fg("muted", snippets.join(theme.fg("dim", " · ")))),
    );
  if (entry.log_path)
    lines.push(
      ...wrap(
        theme.fg(
          "muted",
          render(text.log!, {
            value: theme.fg("accent", cleanActivityDisplay(entry.log_path)),
          }),
        ),
      ),
    );
  for (const [key, value] of [
    ["started", new Date(entry.started_at).toISOString()],
    [
      "ended",
      entry.ended_at ? new Date(entry.ended_at).toISOString() : undefined,
    ],
    ["id", entry.id],
  ])
    if (value)
      lines.push(
        ...wrap(
          theme.fg(
            "muted",
            render(text[key!]!, {
              value: theme.fg("dim", cleanActivityDisplay(value)),
            }),
          ),
        ),
      );
  const pairs = Object.entries(metrics)
    .slice(0, 32)
    .map(([key, value]) =>
      render(text.metric!, {
        key: theme.fg("muted", cleanActivityDisplay(key.replaceAll("_", " "))),
        value: theme.fg(
          "text",
          cleanActivityDisplay(activityMetricValue(key, value)),
        ),
      }),
    );
  lines.push(
    ...wrapTextWithAnsi(pairs.join(theme.fg("dim", " · ")), width).slice(0, 64),
  );
  return lines.slice(0, 120);
}

export function activityDetails(
  entry: ActivityEntry,
  width: number,
  text: Record<string, string>,
  summary: Record<string, string>,
  tail: string,
  level: number,
  theme: Theme,
): string[] {
  if (entry.kind === "shell")
    return shellDetails(entry, width, text, summary, tail, level, theme);
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
    if (value) {
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
