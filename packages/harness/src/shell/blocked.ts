import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

const oneLineReason = (reason: string): string =>
  reason
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" · ")
    .replace(/^Blocked:\s*/, "");

export function renderBlocked(
  description: string,
  reason: string,
  theme: Theme,
): Text {
  return new Text(
    theme.fg("error", "🛑 Blocked: ") +
      theme.fg("dim", description) +
      "\n   " +
      theme.fg("muted", "- Reason: ") +
      theme.fg("text", oneLineReason(reason)),
    0,
    0,
  );
}
