import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { cleanActivityDisplay } from "./lib/activity-details.ts";

type LspCommand =
  | "list_sessions"
  | "list_supported_servers"
  | "start"
  | "stop"
  | "check";

interface LspRenderArgs {
  command?: LspCommand;
  file?: string;
  project_dir?: string;
}

interface LspRenderDetails {
  diagnosticCount?: number;
  errorCount?: number;
  language?: string;
  state?: string;
}

interface LspRenderContext {
  args?: LspRenderArgs;
  isPartial?: boolean;
  isError: boolean;
}

const label = (command?: LspCommand) => command?.replaceAll("_", " ") ?? "…";
const visible = (text: string) =>
  cleanActivityDisplay(text.replaceAll("\t", " · ")).trim();

export function renderLspCall(
  args: LspRenderArgs,
  theme: Theme,
  context: LspRenderContext,
) {
  if (!context.isPartial) return new Container();
  return new Text(
    theme.fg("warning", `⏳ lsp ${label(args.command)}: `) +
      theme.fg("dim", visible(args.file ?? args.project_dir ?? "")),
    0,
    0,
  );
}

function diagnosticLine(line: string, theme: Theme): string {
  const match = /^(L\d+:\d+ )([a-z]+)(\[.*)$/.exec(line);
  if (!match) return theme.fg("muted", visible(line));
  const color =
    match[2] === "error"
      ? "error"
      : match[2] === "warning"
        ? "warning"
        : "muted";
  return (
    theme.fg("muted", match[1]) +
    theme.fg(color, match[2]) +
    theme.fg("text", visible(match[3]))
  );
}

export function renderLspResult(
  result: {
    content: ReadonlyArray<{ type: string; text?: string }>;
    details?: LspRenderDetails;
  },
  options: { isPartial: boolean; expanded: boolean },
  theme: Theme,
  context: LspRenderContext,
) {
  if (options.isPartial) return new Container();
  const args = context.args;
  const command = args?.command ?? "check";
  const raw = result.content.find((item) => item.type === "text")?.text ?? "";
  if (context.isError)
    return new Text(
      theme.fg("error", ` ✗ lsp ${label(command)}: `) +
        theme.fg("text", visible(raw)),
      0,
      0,
    );

  const details = result.details;
  const target = visible(args?.file ?? args?.project_dir ?? "");
  if (command === "check") {
    const count = details?.diagnosticCount;
    const hasDiagnostics =
      count === undefined ? !raw.startsWith("no diagnostics for ") : count > 0;
    const severity = details?.errorCount
      ? "error"
      : hasDiagnostics
        ? "warning"
        : "success";
    const summary =
      count === undefined
        ? hasDiagnostics
          ? "diagnostics reported"
          : "no diagnostics"
        : count
          ? `${count} diagnostic${count === 1 ? "" : "s"}`
          : "no diagnostics";
    const lines = hasDiagnostics ? raw.split("\n").slice(0, 4) : [];
    return new Text(
      theme.fg(severity, `${hasDiagnostics ? " ⚠" : " ✓"} lsp check: `) +
        theme.fg("dim", target) +
        theme.fg("muted", ` · ${summary}`) +
        (lines.length
          ? "\n" +
            lines.map((line) => `   ${diagnosticLine(line, theme)}`).join("\n")
          : ""),
      0,
      0,
    );
  }
  if (command === "start") {
    const state =
      details?.state ?? /\bstate=(\S+)/.exec(raw)?.[1] ?? "starting";
    const active = state === "ready";
    const failed = state === "dead" || state === "install-failed";
    return new Text(
      theme.fg(
        failed ? "error" : active ? "success" : "warning",
        `${failed ? " ✗" : active ? " ✓" : " ⏳"} lsp start: `,
      ) +
        theme.fg(
          "dim",
          visible(
            details?.language ?? /\blanguage=(\S+)/.exec(raw)?.[1] ?? target,
          ),
        ) +
        theme.fg("muted", ` · ${visible(state)}`) +
        (options.expanded ? `\n   ${theme.fg("muted", visible(raw))}` : ""),
      0,
      0,
    );
  }
  if (command === "stop") {
    const none = raw.startsWith("no session");
    return new Text(
      theme.fg(none ? "muted" : "success", `${none ? " ○" : " ✓"} lsp stop: `) +
        theme.fg("dim", visible(raw)),
      0,
      0,
    );
  }
  const entries = raw === "No LSP sessions." ? [] : raw.split("\n");
  const rows = command === "list_sessions" ? entries.slice(1) : entries;
  const name = command === "list_sessions" ? "sessions" : "supported servers";
  const shown = rows.slice(0, 30);
  return new Text(
    theme.fg(
      rows.length ? "success" : "muted",
      `${rows.length ? " ✓" : " ○"} lsp ${name}: `,
    ) +
      theme.fg("muted", rows.length ? String(rows.length) : "none") +
      (rows.length && options.expanded
        ? "\n" +
          shown.map((row) => `   ${theme.fg("dim", visible(row))}`).join("\n") +
          (rows.length > shown.length
            ? `\n   ${theme.fg("muted", `…and ${rows.length - shown.length} more`)}`
            : "")
        : ""),
    0,
    0,
  );
}
