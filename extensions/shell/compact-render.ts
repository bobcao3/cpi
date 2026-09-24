import { Container, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { cleanActivityDisplay } from "../lib/activity-details.ts";

interface CompactDetails {
  describe?: string;
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
      theme.fg("text", description) +
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
  result: { details?: CompactDetails; isError?: boolean },
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
  if (details?.status === "running")
    return new Text(
      theme.fg("warning", `⏳ backgrounded ${name}: `) +
        theme.fg("text", description) +
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
    theme.fg(failed ? "error" : "success", `${failed ? "✗" : "✓"} ${name}: `) +
    theme.fg("text", description);
  if (!failed && details?.exitCode === 0)
    return new Text(heading + suffix, 0, 0);
  const code = details?.exitCode == null ? "—" : String(details.exitCode);
  const lines =
    details?.outputLines == null
      ? ""
      : theme.fg("muted", ` · ${details.outputLines} lines`);
  return new Text(
    `${heading}\n  ${theme.fg(failed ? "error" : "muted", `Exit ${code}`)}${lines}${suffix}`,
    0,
    0,
  );
}
