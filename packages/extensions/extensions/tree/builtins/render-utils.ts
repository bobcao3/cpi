import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getImageDimensions,
  hyperlink,
  imageFallback,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { resolvePath } from "../paths.ts";

export function str(value: unknown): string | null {
  if (typeof value === "string") return value;
  return value == null ? "" : null;
}

export function replaceTabs(text: string): string {
  return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
  return text.replace(/\r/g, "");
}

export function getTextOutput(
  result:
    | {
        content: Array<{
          type: string;
          text?: string;
          data?: string;
          mimeType?: string;
        }>;
      }
    | undefined,
  showImages: boolean,
): string {
  if (!result) return "";
  let output = result.content
    .filter((block) => block.type === "text")
    .map((block) =>
      stripTerminalSequences(block.text ?? "")
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\uFFF9-\uFFFB]/g, "")
        .replace(/\r/g, ""),
    )
    .join("\n");
  if (!getCapabilities().images || !showImages) {
    const indicators = result.content
      .filter((block) => block.type === "image")
      .map((block) => {
        const dimensions =
          block.data && block.mimeType
            ? (getImageDimensions(block.data, block.mimeType) ?? undefined)
            : undefined;
        return imageFallback(block.mimeType ?? "image/unknown", dimensions);
      })
      .join("\n");
    if (indicators) output = output ? `${output}\n${indicators}` : indicators;
  }
  return output;
}

export function renderToolPath(
  rawPath: string | null,
  theme: Theme,
  cwd: string,
  options?: { emptyFallback?: string },
): string {
  if (rawPath === null) return theme.fg("error", "[invalid arg]");
  const value = rawPath || options?.emptyFallback;
  if (!value) return theme.fg("toolOutput", "...");
  const home = homedir();
  const styled = theme.fg(
    "accent",
    value.startsWith(home) ? `~${value.slice(home.length)}` : value,
  );
  return getCapabilities().hyperlinks
    ? hyperlink(styled, pathToFileURL(resolvePath(value, cwd)).href)
    : styled;
}
