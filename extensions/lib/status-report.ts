import type {
  ExtensionContext,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { runForkProbe } from "./fork-probe.ts";
import {
  clearLineSegment,
  registerLineSegment,
  requestFooterRender,
} from "./footer.ts";
import { loadText, textPath } from "./text.ts";

const GLOBAL_KEY = "__cpiStatusReport";
const FORK_ENV = "CPI_FORK_PROBE";
const SEGMENT_NAME = "summary";
const MAX_REPORT_CHARS = 320;

function envInteger(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[key]);
  if (!Number.isInteger(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

const TURN_LIMIT = envInteger("CPI_STATUS_REPORT_TURNS", 10, 1, 1000);
const LONG_TURN_MS = envInteger(
  "CPI_STATUS_REPORT_LONG_TURN_MS",
  5 * 60 * 1000,
  1,
  24 * 60 * 60 * 1000,
);
const PROBE_TIMEOUT_MS = envInteger(
  "CPI_STATUS_REPORT_PROBE_TIMEOUT_MS",
  2 * 60 * 1000,
  1,
  30 * 60 * 1000,
);

interface StatusReportText {
  report: { prompt: string };
}

interface ActiveTurn {
  index: number;
  startedAtMs: number;
}

interface ProbeRequest {
  ctx: ExtensionContext;
  epoch: number;
  parentSessionFile: string;
  turn: number;
}

interface StatusReportState {
  enabled: boolean;
  report: string | null;
  epoch: number;
  turnCount: number;
  activeTurn: ActiveTurn | null;
  probeController: AbortController | null;
}

function state(): StatusReportState {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[GLOBAL_KEY]) {
    globals[GLOBAL_KEY] = {
      enabled: false,
      report: null,
      epoch: 0,
      turnCount: 0,
      activeTurn: null,
      probeController: null,
    } satisfies StatusReportState;
  }
  const current = globals[GLOBAL_KEY] as Partial<StatusReportState>;
  if (!("report" in current)) current.report = null;
  return current as StatusReportState;
}

function cancelWork(s: StatusReportState): void {
  const legacy = s as StatusReportState & {
    longTurnTimer?: NodeJS.Timeout;
    queuedProbe?: ProbeRequest;
  };
  if (legacy.longTurnTimer) clearTimeout(legacy.longTurnTimer);
  delete legacy.longTurnTimer;
  delete legacy.queuedProbe;
  s.probeController?.abort();
  s.probeController = null;
  s.activeTurn = null;
}

function statusReportSegment(): string | null {
  const report = state().report;
  return report ? `[ ${report} ]` : null;
}

function clearStatus(): void {
  state().report = null;
  requestFooterRender();
}

export function setupStatusReports(ctx: ExtensionContext): void {
  const s = state();
  cancelWork(s);
  s.epoch += 1;
  s.turnCount = 0;
  s.enabled = ctx.mode === "tui" && process.env[FORK_ENV] !== "1";
  clearStatus();
  registerLineSegment(SEGMENT_NAME, statusReportSegment);
}

export function disposeStatusReports(): void {
  const s = state();
  cancelWork(s);
  s.epoch += 1;
  s.turnCount = 0;
  s.enabled = false;
  clearStatus();
  clearLineSegment(SEGMENT_NAME);
}

function normalizeReport(answer: string): string | null {
  const withoutAnsi = answer.replace(
    /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/g,
    "",
  );
  const flat = withoutAnsi
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!flat) return null;
  const start = flat.indexOf("I'm ");
  const report = start >= 0 ? flat.slice(start) : flat;
  return Array.from(report).slice(0, MAX_REPORT_CHARS).join("").trim() || null;
}

function publishReport(request: ProbeRequest, report: string): void {
  if (request.ctx.mode !== "tui") return;
  state().report = report;
  requestFooterRender();
}

async function runStatusProbe(request: ProbeRequest): Promise<void> {
  const s = state();
  if (!s.enabled || s.epoch !== request.epoch || request.ctx.signal?.aborted)
    return;
  const controller = new AbortController();
  s.probeController = controller;
  const signal = request.ctx.signal
    ? AbortSignal.any([controller.signal, request.ctx.signal])
    : controller.signal;
  try {
    const text = loadText<StatusReportText>(
      "status-report",
      textPath("status-report"),
    );
    const result = await runForkProbe(
      {
        parentSessionFile: request.parentSessionFile,
        cwd: request.ctx.cwd,
        signal,
        title: `Status summary (turn ${request.turn})`,
        timeoutMs: PROBE_TIMEOUT_MS,
      },
      text.report.prompt,
    );
    const current = state();
    if (
      signal.aborted ||
      current.probeController !== controller ||
      !current.enabled ||
      current.epoch !== request.epoch ||
      !result.ok
    )
      return;
    const report = normalizeReport(result.answer);
    if (report) publishReport(request, report);
  } catch {
  } finally {
    const current = state();
    if (current.probeController !== controller) return;
    current.probeController = null;
  }
}

export function statusReportTurnStarted(
  event: TurnStartEvent,
  _ctx: ExtensionContext,
): void {
  const s = state();
  if (!s.enabled) return;
  s.activeTurn = {
    index: event.turnIndex,
    startedAtMs: Date.now(),
  };
}

export async function statusReportTurnEnded(
  event: TurnEndEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const s = state();
  if (!s.enabled) return;
  const turn = s.activeTurn;
  s.activeTurn = null;
  s.turnCount = Math.min(s.turnCount + 1, TURN_LIMIT);
  const longTurn =
    turn?.index === event.turnIndex &&
    Date.now() - turn.startedAtMs >= LONG_TURN_MS;
  if (!longTurn && s.turnCount < TURN_LIMIT) return;
  s.turnCount = 0;
  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile || ctx.signal?.aborted) return;
  await runStatusProbe({
    ctx,
    epoch: s.epoch,
    parentSessionFile,
    turn: event.turnIndex + 1,
  });
}
