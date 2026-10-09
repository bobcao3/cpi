import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import { getCwd } from "../lib/cwd.ts";
import { displayPath } from "../lib/path-display.ts";
import { expandSourcePath } from "../lib/skill-paths.ts";

export interface ReadDetails {
  kind?: string;
  path?: string;
  text?: string;
  summary?: string;
  message?: string;
  ranges?: number[][];
  lineCount?: number;
}

export function oneLine(value: string): string {
  return sanitizeActivityText(value).split("\n", 1)[0].trim().slice(0, 240);
}

export function fileLabel(
  path: string | undefined,
  theme: Theme,
  color: "text" | "dim" = "text",
  cwd = getCwd(),
): string {
  const absolute = path ? resolve(cwd, path) : undefined;
  const name =
    sanitizeActivityText(
      absolute ? displayPath(absolute, cwd) : "file",
    ).trim() || "file";
  const linked = Boolean(absolute && getCapabilities().hyperlinks);
  const styled = theme.fg(color, linked ? `\x1b[4m${name}\x1b[24m` : name);
  return linked && absolute
    ? hyperlink(styled, pathToFileURL(absolute).href)
    : styled;
}

export function readFileLabel(
  path: string | undefined,
  theme: Theme,
  color: "text" | "dim" = "dim",
  cwd = getCwd(),
): string {
  return fileLabel(path && expandSourcePath(path), theme, color, cwd);
}

export function rangeLabel(details: ReadDetails): string {
  return (details.ranges ?? [])
    .map(
      ([start, end], index) =>
        `${index ? "" : "L"}${start}${end === start ? "" : `-${end}`}`,
    )
    .join(",");
}

export function readDescription(details: ReadDetails | undefined): string {
  const fallback =
    { image: "Image", video: "Video", tree: "Directory" }[
      details?.kind ?? ""
    ] ?? "Query complete (summary unavailable)";
  return oneLine(details?.summary || fallback);
}
