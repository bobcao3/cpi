import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderBlocked } from "./blocked.ts";
import { cleanActivityDisplay } from "../lib/activity-details.ts";

interface CompactDetails {
  id?: string;
  describe?: string;
  blocked?: string;
  shuckBlocked?: boolean;
  shellName?: string;
  status?: string;
  exitCode?: number | null;
  outputLines?: number;
  elapsedMs?: number;
}

interface ShellRenderState {
  startedAt?: number;
  timer?: ReturnType<typeof setInterval>;
}

interface ShellRenderContext {
  args?: { description?: string; waitfor?: number };
  isError: boolean;
  isPartial?: boolean;
  executionStarted?: boolean;
  state?: ShellRenderState;
  invalidate?: () => void;
}

interface SignalRenderDetails {
  id?: string;
  signal?: string;
  describe?: string;
}

interface BackgroundPsEntry {
  id: string;
  describe?: string;
}

interface SignalRenderContext {
  args?: { id?: string; signal?: string };
  isError: boolean;
  isPartial?: boolean;
}

interface BackgroundPsDetails {
  backgrounds?: BackgroundPsEntry[];
  repeats?: BackgroundPsEntry[];
}

function faintWarning(theme: Theme, text: string): string {
  return `\x1b[2m${theme.fg("warning", text)}\x1b[22m`;
}

export function backgroundShellLabel(
  theme: Theme,
  id: string,
  description?: string,
): string {
  const pid = faintWarning(theme, `PID=${cleanActivityDisplay(id)}`);
  const text = cleanActivityDisplay(description?.trim() ?? "");
  return pid + (text ? theme.fg("dim", ` · ${text}`) : "");
}

function formatElapsed(elapsedMs: number): string {
  return elapsedMs < 1500
    ? `${Math.round(elapsedMs)}ms`
    : `${Math.round(elapsedMs / 1000)}s`;
}

function elapsedSuffix(
  elapsedMs: number | undefined,
  waitfor: number | undefined,
  theme: Theme,
): string {
  return elapsedMs === undefined
    ? ""
    : theme.fg(
        "muted",
        ` (${formatElapsed(elapsedMs)}${waitfor === undefined ? "" : `, wait for ${waitfor}s`})`,
      );
}

export function renderCompactShellCall(
  args: { description?: string; waitfor?: number },
  theme: Theme,
  context: ShellRenderContext,
  defaultWaitfor: number,
  shellName: string,
) {
  const state = context.state;
  if (!context.isPartial) {
    if (state?.timer) clearInterval(state.timer);
    if (state) state.timer = undefined;
    return new Container();
  }
  if (context.executionStarted && state && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.timer = setInterval(() => context.invalidate?.(), 1000);
    state.timer.unref();
  }
  const description = cleanActivityDisplay(args.description?.trim() || "shell");
  return new Text(
    theme.fg("warning", `⏳ ${shellName}: `) +
      theme.fg("dim", description) +
      elapsedSuffix(
        state?.startedAt === undefined
          ? undefined
          : Date.now() - state.startedAt,
        args.waitfor ?? defaultWaitfor,
        theme,
      ),
    0,
    0,
  );
}

export function renderCompactShellResult(
  result: {
    details?: CompactDetails;
    isError?: boolean;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  },
  options: { isPartial: boolean },
  theme: Theme,
  context: ShellRenderContext,
  shellName: string,
) {
  if (options.isPartial) return new Container();
  const details = result.details;
  const args = context.args;
  const name = details?.shellName ?? shellName;
  const description = cleanActivityDisplay(
    details?.describe?.trim() || args?.description?.trim() || "shell",
  );
  const suffix = elapsedSuffix(details?.elapsedMs, undefined, theme);
  const blockedReason =
    details?.blocked ??
    (details?.shuckBlocked
      ? result.content
          ?.find((section) => section.type === "text")
          ?.text?.split("\n---\n")[0]
      : undefined);
  if (blockedReason) return renderBlocked(description, blockedReason, theme);
  if (details?.status === "running")
    return new Text(
      theme.fg("warning", `⏳ backgrounded ${name}: `) +
        backgroundShellLabel(theme, details.id ?? "unknown", description) +
        (details.elapsedMs === undefined
          ? ""
          : theme.fg(
              "muted",
              ` (backgrounded after ${formatElapsed(details.elapsedMs)})`,
            )),
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
      `${failed ? " ✗" : " ✓"} ${name}: `,
    ) + theme.fg("dim", description);
  if (!failed && details?.exitCode === 0)
    return new Text(heading + suffix, 0, 0);
  const code = details?.exitCode == null ? "—" : String(details.exitCode);
  const lines =
    details?.outputLines == null
      ? ""
      : theme.fg("muted", ` · ${details.outputLines} lines`);
  return new Text(
    `${heading}\n   ${theme.fg(failed ? "error" : "muted", `Exit ${code}`)}${lines}${suffix}`,
    0,
    0,
  );
}

export function renderCompactSignalResult(
  result: {
    details?: SignalRenderDetails;
    isError?: boolean;
    content?: ReadonlyArray<{ type?: string; text?: string }>;
  },
  options: { isPartial: boolean },
  theme: Theme,
  context: SignalRenderContext,
) {
  if (options.isPartial) return new Container();
  const details = result.details;
  const args = context.args;
  const id = details?.id ?? args?.id ?? "";
  const sig = details?.signal ?? args?.signal ?? "SIGINT";
  if (context.isError || result.isError) {
    const raw =
      result.content?.find((section) => section.type === "text")?.text ??
      `Background ${id} not active.`;
    return new Text(
      theme.fg("error", ` ✗ ${sig}: `) +
        theme.fg("dim", cleanActivityDisplay(raw)),
      0,
      0,
    );
  }
  return new Text(
    theme.fg("text", ` → Sent ${sig} to `) +
      (id.startsWith("rpt-")
        ? faintWarning(theme, id) +
          (details?.describe
            ? theme.fg("dim", ` · ${cleanActivityDisplay(details.describe)}`)
            : "")
        : backgroundShellLabel(theme, id, details?.describe)),
    0,
    0,
  );
}

export function renderCompactBackgroundPsResult(
  result: { details?: BackgroundPsDetails },
  options: { isPartial: boolean },
  theme: Theme,
) {
  if (options.isPartial) return new Container();
  const bgs = result.details?.backgrounds ?? [];
  const rpts = result.details?.repeats ?? [];
  if (bgs.length === 0 && rpts.length === 0)
    return new Text(theme.fg("text", " ○ No background shells"), 0, 0);
  const rows = [theme.fg("text", " ○ Listed background shells:")];
  const items = [
    ...bgs.map((e) => backgroundShellLabel(theme, e.id, e.describe)),
    ...rpts.map((e) => {
      const d = cleanActivityDisplay(e.describe?.trim() ?? "");
      return (
        faintWarning(theme, e.id) +
        theme.fg("accent", " [repeating]") +
        (d ? theme.fg("muted", ` ${d}`) : "")
      );
    }),
  ];
  items.forEach((body, i) => {
    const branch = i === items.length - 1 ? "└─" : "├─";
    rows.push(theme.fg("dim", `   ${branch} `) + body);
  });
  return new Text(rows.join("\n"), 0, 0);
}
