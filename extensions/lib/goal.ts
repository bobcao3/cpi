/** Goal state persists on globalThis and in the session transcript; fork-probe children disable goal logic to prevent recursion. */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { runForkProbe } from "./fork-probe.ts";
import { loadText, render, textPath } from "./text.ts";

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const MAX_TURNS = envInt("CPI_GOAL_MAX_TURNS", 40);
const MAX_DURATION_MS = envInt("CPI_GOAL_MAX_DURATION_MS", 2 * 60 * 60 * 1000);
/** Probe timeout bound. */
const PROBE_TIMEOUT_MS = envInt("CPI_GOAL_PROBE_TIMEOUT_MS", 3 * 60 * 1000);
export const GOAL_STATE_ENTRY = "goal-state";
export const GOAL_MSG_TYPE = "goal-message";
const AUDIT_TYPE = "goal-eval";
const FORK_ENV = "CPI_FORK_PROBE";

interface GoalText {
  command: {
    description: string;
    status: string;
    achieved: string;
    budget: string;
  };
  evaluate: { prompt: string };
  continue: { message: string };
  stuck: { message: string };
}

const GLOBAL_KEY = "__cpiGoal";

interface GoalState {
  objective: string | null;
  active: boolean;
  paused: boolean;
  turnCount: number;
  startedAtMs: number | null;
}

function state(): GoalState {
  const g = globalThis as Record<string, unknown>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      objective: null,
      active: false,
      paused: false,
      turnCount: 0,
      startedAtMs: null,
    } satisfies GoalState;
  }
  return g[GLOBAL_KEY] as GoalState;
}

/** Fork-child guard. */
function inForkChild(): boolean {
  return process.env[FORK_ENV] === "1";
}

export function isGoalActive(): boolean {
  if (inForkChild()) return false;
  const s = state();
  return s.active && !s.paused;
}

export function isGoalPaused(): boolean {
  return state().paused;
}

export function getObjective(): string | null {
  return state().objective;
}

function persistGoal(pi: ExtensionAPI): void {
  const s = state();
  try {
    pi.appendEntry(GOAL_STATE_ENTRY, {
      objective: s.objective,
      active: s.active,
      paused: s.paused,
      turnCount: s.turnCount,
      startedAtMs: s.startedAtMs,
    });
  } catch {}
}

/** Replay latest goal-state. */
export function reconstructGoal(ctx: ExtensionContext): void {
  let found: GoalState | undefined;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "custom" && entry.customType === GOAL_STATE_ENTRY) {
      const d = entry.data as Partial<GoalState> | undefined;
      if (d) {
        found = {
          objective: d.objective ?? null,
          active: !!d.active,
          paused: !!d.paused,
          turnCount: d.turnCount ?? 0,
          startedAtMs: d.startedAtMs ?? null,
        };
      }
    }
  }
  const s = state();
  if (found) {
    Object.assign(s, found);
  } else {
    Object.assign(s, {
      objective: null,
      active: false,
      paused: false,
      turnCount: 0,
      startedAtMs: null,
    });
  }
}

export function setGoal(pi: ExtensionAPI, objective: string): void {
  const s = state();
  s.objective = objective;
  s.active = true;
  s.paused = false;
  s.turnCount = 0;
  s.startedAtMs = Date.now();
  persistGoal(pi);
}

export function clearGoal(pi: ExtensionAPI): void {
  Object.assign(state(), {
    objective: null,
    active: false,
    paused: false,
    turnCount: 0,
    startedAtMs: null,
  });
  persistGoal(pi);
}

export function pauseGoal(pi: ExtensionAPI): void {
  const s = state();
  if (!s.active) return;
  s.paused = true;
  persistGoal(pi);
}

export function resumeGoal(pi: ExtensionAPI): void {
  const s = state();
  if (!s.active) return;
  s.paused = false;
  s.turnCount = 0;
  s.startedAtMs = Date.now();
  persistGoal(pi);
}

export function renderGoalStatus(): string {
  const s = state();
  const T = loadText<GoalText>("goal", textPath("goal"));
  if (!s.active || !s.objective)
    return "No active goal. Set one with: /goal <objective>";
  const elapsed = s.startedAtMs
    ? Math.round((Date.now() - s.startedAtMs) / 60000)
    : 0;
  return render(T.command.status, {
    objective: s.objective,
    state: s.paused ? "paused" : "active",
    turns: s.turnCount,
    elapsed: `${elapsed}m`,
  });
}

function sendGoalMessage(
  pi: ExtensionAPI,
  kind: string,
  content: string,
  details: Record<string, unknown>,
): void {
  try {
    pi.sendMessage(
      {
        customType: GOAL_MSG_TYPE,
        content,
        display: true,
        details: { kind, ...details },
      },
      { triggerTurn: true, deliverAs: "steer" },
    );
  } catch {}
}

function audit(
  pi: ExtensionAPI,
  verdict: string,
  extra: Record<string, unknown>,
): void {
  try {
    pi.appendEntry(AUDIT_TYPE, {
      verdict,
      ...extra,
      at: new Date().toISOString(),
    });
  } catch {}
}

export type GoalEvalStatus = "met" | "continue" | "failed";
export interface GoalEvalResult {
  status: GoalEvalStatus;
  reason: string;
}

/** Parse YES/NO/null. */
function parseVerdict(answer: string): "YES" | "NO" | null {
  for (const raw of answer.split("\n")) {
    const line = raw.trim().toUpperCase();
    if (!line) continue;
    if (line.startsWith("YES")) return "YES";
    if (line.startsWith("NO")) return "NO";
    return null;
  }
  return null;
}

function extractReason(answer: string): string {
  const lines = answer
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length <= 1) return "";
  return lines
    .slice(1)
    .join(" ")
    .replace(/^\s*(YES|NO)\s*[:,-]?\s*/i, "")
    .trim();
}

/** Probe failures never reject. */
export async function evaluateGoal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<GoalEvalResult> {
  const s = state();
  if (inForkChild() || !s.active || s.paused || !s.objective) {
    return { status: "failed", reason: "no active goal" };
  }
  const parentFile = ctx.sessionManager?.getSessionFile();
  if (!parentFile) return { status: "failed", reason: "no session file" };
  const T = loadText<GoalText>("goal", textPath("goal"));
  const result = await runForkProbe(
    {
      command: process.env.CPI_FORK_PI_BIN,
      parentSessionFile: parentFile,
      cwd: ctx.cwd,
      signal: ctx.signal,
      timeoutMs: PROBE_TIMEOUT_MS,
    },
    render(T.evaluate.prompt, { objective: s.objective }),
  );
  if (!result.ok) {
    audit(pi, "failed", {
      reason: result.errorMessage ?? "probe failed",
      turns: s.turnCount,
    });
    return {
      status: "failed",
      reason: result.errorMessage ?? "evaluator probe failed",
    };
  }
  const verdict = parseVerdict(result.answer);
  const reason = extractReason(result.answer);
  if (verdict === "YES") {
    audit(pi, "met", { reason, turns: s.turnCount });
    return { status: "met", reason };
  }
  audit(pi, verdict === "NO" ? "no" : "ambiguous", {
    reason,
    turns: s.turnCount,
  });
  return {
    status: "continue",
    reason: reason || "evaluator response was ambiguous",
  };
}

/** Budget pause. */
export function continueGoal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): void {
  const s = state();
  if (inForkChild() || !s.active || s.paused || !s.objective) return;
  s.turnCount += 1;
  const cap =
    s.turnCount > MAX_TURNS
      ? `turn cap reached (${MAX_TURNS})`
      : s.startedAtMs !== null && Date.now() - s.startedAtMs > MAX_DURATION_MS
        ? "time cap reached"
        : null;
  if (cap) {
    budgetPauseGoal(pi, ctx, cap);
    return;
  }
  const T = loadText<GoalText>("goal", textPath("goal"));
  sendGoalMessage(
    pi,
    "continue",
    render(T.continue.message, {
      objective: s.objective,
      reason,
      turns: s.turnCount,
    }),
    { objective: s.objective, reason, turns: s.turnCount },
  );
  persistGoal(pi);
}

/** Success starts no turn. */
export function achieveGoal(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const s = state();
  const objective = s.objective ?? "";
  const turns = s.turnCount;
  clearGoal(pi);
  const T = loadText<GoalText>("goal", textPath("goal"));
  try {
    ctx.ui.notify(render(T.command.achieved, { objective, turns }), "info");
  } catch {}
  audit(pi, "achieved", { objective, turns });
}

/** Budget starts no turn. */
export function budgetPauseGoal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  reason: string,
): void {
  const s = state();
  s.paused = true;
  persistGoal(pi);
  const T = loadText<GoalText>("goal", textPath("goal"));
  try {
    ctx.ui.notify(
      render(T.command.budget, {
        objective: s.objective ?? "",
        reason,
        turns: s.turnCount,
      }),
      "warning",
    );
  } catch {}
  audit(pi, "budget", { reason, turns: s.turnCount });
}

/** Stuck resume enforces budget. */
export function goalStuckResume(
  pi: ExtensionAPI,
  elapsedMin: number,
  pendingText: string,
): void {
  const s = state();
  if (inForkChild() || !s.active || s.paused || !s.objective) return;
  s.turnCount += 1;
  const cap =
    s.turnCount > MAX_TURNS
      ? `turn cap reached (${MAX_TURNS})`
      : s.startedAtMs !== null && Date.now() - s.startedAtMs > MAX_DURATION_MS
        ? "time cap reached"
        : null;
  if (cap) {
    s.paused = true;
    persistGoal(pi);
    audit(pi, "budget", { reason: "stuck-resume cap", turns: s.turnCount });
    return;
  }
  const T = loadText<GoalText>("goal", textPath("goal"));
  sendGoalMessage(
    pi,
    "stuck",
    render(T.stuck.message, {
      objective: s.objective,
      elapsed_min: elapsedMin,
      pending: pendingText,
    }),
    { objective: s.objective, elapsed_min: elapsedMin, pending: pendingText },
  );
  audit(pi, "stuck-resume", {
    elapsed_min: elapsedMin,
    pending: pendingText,
    turns: s.turnCount,
  });
  persistGoal(pi);
}
