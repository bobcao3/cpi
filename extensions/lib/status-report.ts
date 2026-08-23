import type {
  ExtensionContext,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import { runForkProbe } from "./fork-probe.ts";
import { loadText, textPath } from "./text.ts";

const GLOBAL_KEY = "__cpiStatusReport";
const FORK_ENV = "CPI_FORK_PROBE";
const STATUS_KEY = "cpi-status-report";
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
  reportTriggered: boolean;
}

interface ProbeRequest {
  ctx: ExtensionContext;
  epoch: number;
  parentSessionFile: string;
}

interface StatusReportState {
  enabled: boolean;
  epoch: number;
  turnCount: number;
  activeTurn: ActiveTurn | null;
  longTurnTimer: NodeJS.Timeout | null;
  probeController: AbortController | null;
  queuedProbe: ProbeRequest | null;
}

function state(): StatusReportState {
  const globals = globalThis as Record<string, unknown>;
  if (!globals[GLOBAL_KEY]) {
    globals[GLOBAL_KEY] = {
      enabled: false,
      epoch: 0,
      turnCount: 0,
      activeTurn: null,
      longTurnTimer: null,
      probeController: null,
      queuedProbe: null,
    } satisfies StatusReportState;
  }
  return globals[GLOBAL_KEY] as StatusReportState;
}

function clearLongTurnTimer(s: StatusReportState): void {
  if (s.longTurnTimer) clearTimeout(s.longTurnTimer);
  s.longTurnTimer = null;
}

function cancelWork(s: StatusReportState): void {
  clearLongTurnTimer(s);
  s.probeController?.abort();
  s.probeController = null;
  s.queuedProbe = null;
  s.activeTurn = null;
}

function clearStatus(ctx: ExtensionContext): void {
  if (ctx.mode !== "tui") return;
  try {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch {}
}

export function setupStatusReports(ctx: ExtensionContext): void {
  const s = state();
  cancelWork(s);
  s.epoch += 1;
  s.turnCount = 0;
  s.enabled = ctx.mode === "tui" && process.env[FORK_ENV] !== "1";
  clearStatus(ctx);
}

export function disposeStatusReports(ctx: ExtensionContext): void {
  const s = state();
  cancelWork(s);
  s.epoch += 1;
  s.turnCount = 0;
  s.enabled = false;
  clearStatus(ctx);
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
  try {
    request.ctx.ui.setStatus(
      STATUS_KEY,
      request.ctx.ui.theme.fg("border", `[ ${report} ]`),
    );
  } catch {}
}

async function runStatusProbe(request: ProbeRequest): Promise<void> {
  const s = state();
  if (!s.enabled || s.epoch !== request.epoch) return;
  const controller = new AbortController();
  s.probeController = controller;
  try {
    const text = loadText<StatusReportText>(
      "status-report",
      textPath("status-report"),
    );
    const result = await runForkProbe(
      {
        parentSessionFile: request.parentSessionFile,
        cwd: request.ctx.cwd,
        signal: controller.signal,
        timeoutMs: PROBE_TIMEOUT_MS,
      },
      text.report.prompt,
    );
    const current = state();
    if (
      controller.signal.aborted ||
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
    const queued = current.queuedProbe;
    current.queuedProbe = null;
    if (queued && current.enabled && current.epoch === queued.epoch) {
      void runStatusProbe(queued);
    }
  }
}

function requestReport(ctx: ExtensionContext, epoch: number): void {
  const s = state();
  if (!s.enabled || s.epoch !== epoch) return;
  s.turnCount = 0;
  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) return;
  const request = { ctx, epoch, parentSessionFile } satisfies ProbeRequest;
  if (s.probeController) {
    s.queuedProbe = request;
    return;
  }
  void runStatusProbe(request);
}

export function statusReportTurnStarted(
  event: TurnStartEvent,
  ctx: ExtensionContext,
): void {
  const s = state();
  if (!s.enabled) return;
  clearLongTurnTimer(s);
  const epoch = s.epoch;
  s.activeTurn = {
    index: event.turnIndex,
    startedAtMs: Date.now(),
    reportTriggered: false,
  };
  s.longTurnTimer = setTimeout(() => {
    const current = state();
    const turn = current.activeTurn;
    current.longTurnTimer = null;
    if (
      !current.enabled ||
      current.epoch !== epoch ||
      !turn ||
      turn.index !== event.turnIndex
    )
      return;
    turn.reportTriggered = true;
    requestReport(ctx, epoch);
  }, LONG_TURN_MS);
  s.longTurnTimer.unref?.();
}

export function statusReportTurnEnded(
  event: TurnEndEvent,
  ctx: ExtensionContext,
): void {
  const s = state();
  if (!s.enabled) return;
  const turn = s.activeTurn;
  clearLongTurnTimer(s);
  s.activeTurn = null;
  s.turnCount = Math.min(s.turnCount + 1, TURN_LIMIT);
  const longTurn =
    !!turn &&
    turn.index === event.turnIndex &&
    !turn.reportTriggered &&
    Date.now() - turn.startedAtMs >= LONG_TURN_MS;
  if (longTurn || s.turnCount >= TURN_LIMIT) {
    requestReport(ctx, s.epoch);
  }
}
