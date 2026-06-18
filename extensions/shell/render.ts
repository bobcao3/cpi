/**
 * TUI rendering for the `sh` tool — call display, result display,
 * and ANSI sanitization. Extracted from shell.ts to keep it under line limits.
 */

import { Text, truncateToWidth } from "@earendil-works/pi-tui";

const truncateLine = (line: string, width: number) =>
  truncateToWidth(line, width, "…").replace("\x1b[0m…", "…");

export function truncatedPreview(
  lines: string[],
  summary: string,
): { invalidate(): void; render(width: number): string[] } {
  return {
    invalidate() {},
    render(width: number): string[] {
      return [...lines.map((l) => truncateLine(l, width)), truncateLine(summary, width)];
    },
  };
}

export function renderShCall(
  args: any,
  theme: any,
  context: any,
  defaultWaitfor: number,
  tailLines: number,
): Text {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const waitfor = args.waitfor ?? defaultWaitfor;
  const waitforSuffix = waitfor ? theme.fg("muted", ` (waitfor ${waitfor}s)`) : "";
  const repeatSuffix =
    args.interval != null
      ? theme.fg(
          "muted",
          ` (every ${args.interval}s · trigger on code ${args.end_monitor_retcode} · keep looping on code ${args.keep_looping_retcode})`,
        )
      : "";
  const cmdLines: string[] = args.command.split("\n");

  if (cmdLines.length <= tailLines) {
    text.setText(
      theme.fg("toolTitle", theme.bold(`$ ${args.command}`)) + waitforSuffix + repeatSuffix,
    );
  } else if (context.expanded) {
    const rest = cmdLines
      .slice(1)
      .map((l: string) => theme.fg("toolTitle", l))
      .join("\n");
    text.setText(
      theme.fg("toolTitle", theme.bold(`$ ${cmdLines[0]}`)) +
        "\n" +
        rest +
        theme.fg("dim", " · Ctrl+O to collapse") +
        waitforSuffix +
        repeatSuffix,
    );
  } else {
    const tailStart = cmdLines.length - 3;
    const hint = theme.fg("dim", ` showing ${tailStart}-${cmdLines.length} (Ctrl+O to expand)`);
    const tail = cmdLines
      .slice(-4)
      .map((l: string) => theme.fg("toolTitle", theme.bold(l)))
      .join("\n");
    text.setText(
      theme.fg("toolTitle", theme.bold(`$ ${cmdLines[0]}`)) +
        hint +
        waitforSuffix +
        repeatSuffix +
        "\n" +
        theme.fg("dim", "...") +
        "\n" +
        tail,
    );
  }
  return text;
}

interface ShResultDetails {
  id?: string;
  exitCode?: number | null;
  status?: string;
  fullOutputPath?: string;
  describe?: string;
  shuckWarnings?: string;
  shuckBlocked?: boolean;
  interval?: number;
  endCode?: number;
  keepCode?: number;
}

export function renderShResult(
  result: any,
  opts: { expanded: boolean; isPartial: boolean },
  theme: any,
  tailLines: number,
): Text {
  const { expanded, isPartial } = opts;
  const content = result.content[0];
  let fullText = content?.type === "text" ? content.text : "";
  const details = result.details as ShResultDetails | undefined;

  if (details?.shuckWarnings) {
    const warnEnd = fullText.indexOf("\n---\n");
    if (warnEnd !== -1) fullText = fullText.slice(warnEnd + 5);
  }

  const sepIdx = fullText.indexOf("\n---\n");
  const outputText = sepIdx !== -1 ? fullText.slice(0, sepIdx) : fullText;
  const outputLines = outputText
    .trimEnd()
    .split("\n")
    .filter((l: string) => l !== "")
    .map((t) =>
      t
        .replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x6c\x6e-\x7e]/g, "")
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\_[^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1bP[^\x1b]*(?:\x1b\\|\x9c)/g, "")
        .replace(/\t/g, "   ")
        .replace(/\r/g, ""),
    );
  const totalLines = outputLines.length;

  // Streaming
  if (isPartial) {
    const tail = outputLines.slice(-tailLines);
    const hidden = outputLines.length - tail.length;
    let summary =
      theme.fg("warning", "⏳ running") +
      (hidden > 0
        ? theme.fg("dim", ` · showing L${hidden + 1}-${outputLines.length} (Ctrl+O to expand)`)
        : theme.fg("dim", ` · ${outputLines.length} lines`));
    return outputText.trim()
      ? new Text(
          tail.map((l: string) => theme.fg("toolOutput", l)).join("\n") + "\n" + summary,
          0,
          0,
        )
      : new Text(summary, 0, 0);
  }

  // Completed
  const isRunning = details?.status === "running";
  const isRepeating = details?.status === "repeating";
  const exitCode = details?.exitCode;
  let status = "";
  if (details?.shuckBlocked) status = theme.fg("error", "✗ blocked");
  else if (isRunning) {
    status = theme.fg("warning", "⏳ backgrounded");
    if (details?.id) status += theme.fg("dim", ` PID=${details.id}`);
    if (details?.fullOutputPath) status += theme.fg("dim", ` · ${details.fullOutputPath}`);
  } else if (isRepeating) {
    status =
      theme.fg("warning", "⏳ repeating") +
      theme.fg(
        "dim",
        ` PID=${details.id} every ${details.interval}s · trigger on code ${details.endCode} · keep looping on code ${details.keepCode}`,
      );
  } else if (exitCode != null && exitCode !== 0) status = theme.fg("error", `exit ${exitCode}`);
  else status = theme.fg("success", "✓");

  if (expanded) {
    let summary = status + theme.fg("dim", ` · ${totalLines} lines · Ctrl+O to collapse`);
    if (details?.fullOutputPath) summary += theme.fg("warning", " [truncated]");
    let t =
      totalLines > 0
        ? outputLines.map((l: string) => theme.fg("toolOutput", l)).join("\n")
        : theme.fg("dim", "(no output)");
    if (details?.fullOutputPath)
      t += `\n${theme.fg("dim", `Full output: ${details.fullOutputPath}`)}`;
    return new Text(t + "\n" + summary, 0, 0);
  }

  if (totalLines === 0) return new Text(theme.fg("dim", "(no output)") + "\n" + status, 0, 0);
  if (totalLines <= tailLines)
    return truncatedPreview(
      outputLines.map((l: string) => theme.fg("toolOutput", l)),
      status + theme.fg("dim", ` · ${totalLines} lines`),
    );
  const startLine = totalLines - tailLines + 1;
  let summary =
    status + theme.fg("dim", ` · showing L${startLine}-${totalLines} (Ctrl+O to expand)`);
  if (details?.fullOutputPath) summary += theme.fg("warning", " [truncated]");
  return truncatedPreview(
    outputLines.slice(-tailLines).map((l: string) => theme.fg("toolOutput", l)),
    summary,
  );
}
