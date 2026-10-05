import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { cleanActivityDisplay } from "../lib/activity-details.ts";
import { renderBlocked } from "./blocked.ts";

interface RepeatArgs {
  description?: string;
  interval?: number;
}

interface RepeatDetails {
  id?: string;
  description?: string;
  interval?: number;
  blocked?: string;
  shuckBlocked?: boolean;
  shuckWarnings?: string;
}

interface RepeatContext {
  args?: RepeatArgs;
  isPartial?: boolean;
  isError: boolean;
}

const visible = (value: string) => cleanActivityDisplay(value).trim();

export function renderRepeatCall(
  args: RepeatArgs,
  theme: Theme,
  context: RepeatContext,
) {
  if (!context.isPartial) return new Container();
  return new Text(
    theme.fg("warning", "⏳ Monitor: ") +
      theme.fg("dim", visible(args.description ?? "shell")) +
      theme.fg("muted", ` (every ${args.interval ?? "?"}s)`),
    0,
    0,
  );
}

export function renderRepeatResult(
  result: {
    content: ReadonlyArray<{ type: string; text?: string }>;
    details?: unknown;
  },
  options: { isPartial: boolean },
  theme: Theme,
  context: RepeatContext,
) {
  if (options.isPartial) return new Container();
  const details = result.details as RepeatDetails | undefined;
  const raw = result.content.find((item) => item.type === "text")?.text ?? "";
  const description = visible(
    details?.description ?? context.args?.description ?? "shell",
  );
  const blocked =
    details?.blocked ??
    (details?.shuckBlocked ? raw.split("\n---\n")[0] : undefined);
  if (blocked) return renderBlocked(description, blocked, theme);
  if (context.isError)
    return new Text(
      theme.fg("error", " ✗ Monitor: ") +
        theme.fg("dim", description) +
        theme.fg("text", ` · ${visible(raw)}`),
      0,
      0,
    );
  const id = visible(details?.id ?? "");
  const warning = details?.shuckWarnings
    ? "\n   " +
      theme.fg("warning", `⚠ ${visible(details.shuckWarnings).slice(0, 240)}`)
    : "";
  return new Text(
    theme.fg("warning", "⏳ Monitor ") +
      `\x1b[2m${theme.fg("warning", id)}\x1b[22m` +
      theme.fg("dim", `: ${description}`) +
      theme.fg(
        "muted",
        ` · every ${details?.interval ?? context.args?.interval ?? "?"}s`,
      ) +
      warning,
    0,
    0,
  );
}
