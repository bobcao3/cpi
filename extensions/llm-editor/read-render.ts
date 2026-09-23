import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  hyperlink,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";

interface ReadDetails {
  kind?: string;
  summary?: string;
  message?: string;
}

function oneLine(value: string): string {
  return sanitizeActivityText(value).split("\n", 1)[0].trim().slice(0, 240);
}

function fileLabel(
  path: string | undefined,
  theme: Theme,
  cwd?: string,
): string {
  const name = oneLine(basename(path || "file")) || "file";
  const linked = Boolean(path && getCapabilities().hyperlinks);
  const styled = theme.fg("text", linked ? `\x1b[4m${name}\x1b[24m` : name);
  return linked
    ? hyperlink(
        styled,
        pathToFileURL(resolve(cwd ?? process.cwd(), path!)).href,
      )
    : styled;
}

function compactLine(value: string) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return [truncateToWidth(value, width, "…")];
    },
  };
}

export function renderReadCall(
  args: { path?: string; query?: string },
  theme: Theme,
  context: { isPartial: boolean; cwd?: string },
) {
  if (!context.isPartial) return new Container();
  const file = fileLabel(args.path, theme, context.cwd);
  const query = oneLine(args.query || "");
  return compactLine(
    theme.fg("warning", "⏳ Reading ") +
      file +
      theme.fg("text", query ? ` for ${query}` : ""),
  );
}

export function renderReadResult(
  result: {
    details?: ReadDetails;
    content?: { type: string; text?: string }[];
  },
  options: { isPartial: boolean },
  theme: Theme,
  context: { args?: unknown; isError: boolean; cwd?: string },
) {
  if (options.isPartial) return new Container();
  const args = context.args as { path?: string } | undefined;
  const file = fileLabel(args?.path, theme, context.cwd);
  const details = result.details;
  if (context.isError || details?.kind === "error") {
    const error = oneLine(
      details?.message ||
        result.content?.find((part) => part.type === "text")?.text ||
        "Read failed",
    );
    return compactLine(
      theme.fg("error", "✗ Failed to read ") +
        file +
        theme.fg("text", `: ${error}`),
    );
  }
  if (details?.kind === "content")
    return compactLine(theme.fg("success", "✓ Read ") + file);
  const summary = oneLine(
    details?.summary ||
      ({
        tree: "Directory listing",
        image: "Image",
        video: "Video",
      }[details?.kind || ""] ??
        "Query complete (summary unavailable)"),
  );
  return compactLine(
    theme.fg("success", "✓ Read ") + file + theme.fg("text", `: ${summary}`),
  );
}
