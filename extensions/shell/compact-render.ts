import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { cleanActivityDisplay } from "../lib/activity-details.ts";

interface CompactDetails {
  describe?: string;
  status?: string;
  exitCode?: number | null;
  outputLines?: number;
}

export function renderCompactShellCall(
  args: { description?: string },
  theme: Theme,
  context: { isPartial: boolean },
) {
  if (!context.isPartial) return new Container();
  const description = cleanActivityDisplay(args.description?.trim() || "shell");
  return new Text(
    theme.fg("warning", "⏳ Running shell: ") + theme.fg("text", description),
    0,
    0,
  );
}

export function renderCompactShellResult(
  result: { details?: CompactDetails; isError?: boolean },
  options: { isPartial: boolean },
  theme: Theme,
  context: { args?: unknown; isError: boolean },
) {
  if (options.isPartial) return new Container();
  const details = result.details;
  const args = context.args as { description?: string } | undefined;
  const description = cleanActivityDisplay(
    details?.describe?.trim() || args?.description?.trim() || "shell",
  );
  if (details?.status === "running")
    return new Text(
      theme.fg("text", `⏳ Backgrounded shell: ${description}`),
      0,
      0,
    );
  const failed =
    context.isError ||
    result.isError ||
    (details?.exitCode != null && details.exitCode !== 0);
  const heading =
    theme.fg(
      failed ? "error" : "success",
      failed ? "✗ Ran shell: " : "✓ Ran shell: ",
    ) + theme.fg("text", description);
  if (!failed && details?.exitCode === 0) return new Text(heading, 0, 0);
  const code = details?.exitCode == null ? "—" : String(details.exitCode);
  const lines =
    details?.outputLines == null
      ? ""
      : theme.fg("muted", ` · ${details.outputLines} lines`);
  return new Text(
    `${heading}\n  ${theme.fg(failed ? "error" : "muted", `Exit ${code}`)}${lines}`,
    0,
    0,
  );
}
