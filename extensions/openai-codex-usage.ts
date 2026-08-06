import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const STATUS_KEY = "openai-codex-usage";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_LIMIT_BYTES = 64 * 1024;
const POLL_MS = 30_000;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountIdFromToken(token: string): string | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (!isRecord(payload)) return undefined;
    const auth = payload["https://api.openai.com/auth"];
    if (!isRecord(auth)) return undefined;
    const accountId = auth.chatgpt_account_id;
    return typeof accountId === "string" && accountId.length > 0
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Codex usage response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        throw new Error("Codex usage response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
  return JSON.parse(body);
}

export type UsageWindow = {
  usedPercent: number;
  resetAt?: number;
};

export type UsageReport = {
  primary?: UsageWindow;
  secondary?: UsageWindow;
};

function resetAtFromWindow(
  window: JsonRecord,
  capturedAt: number,
): number | undefined {
  for (const key of [
    "reset_at",
    "resets_at",
    "reset_time",
    "end_time",
    "ends_at",
    "expires_at",
  ]) {
    const value = window[key];
    let timestamp: number | undefined;
    if (typeof value === "number" && Number.isFinite(value)) timestamp = value;
    if (typeof value === "string") {
      const numeric = Number(value);
      timestamp = Number.isFinite(numeric) ? numeric : Date.parse(value);
    }
    if (
      timestamp !== undefined &&
      Number.isFinite(timestamp) &&
      timestamp > 0
    ) {
      return timestamp < 100_000_000_000 ? timestamp * 1000 : timestamp;
    }
  }
  const after = window.reset_after_seconds;
  return typeof after === "number" && Number.isFinite(after) && after >= 0
    ? capturedAt + after * 1000
    : undefined;
}

function parseWindow(
  value: unknown,
  capturedAt: number,
): UsageWindow | undefined {
  if (!isRecord(value) || typeof value.used_percent !== "number")
    return undefined;
  if (!Number.isFinite(value.used_percent) || value.used_percent < 0)
    return undefined;
  return {
    usedPercent: Math.min(100, value.used_percent),
    resetAt: resetAtFromWindow(value, capturedAt),
  };
}

export function parseUsageReport(
  payload: unknown,
  capturedAt = Date.now(),
): UsageReport | undefined {
  if (!isRecord(payload)) return undefined;
  const rateLimit = payload.rate_limit;
  if (!isRecord(rateLimit)) return undefined;
  const primary = parseWindow(rateLimit.primary_window, capturedAt);
  const secondary = parseWindow(rateLimit.secondary_window, capturedAt);
  return primary || secondary ? { primary, secondary } : undefined;
}

export function formatDualBar(
  primary: UsageWindow,
  secondary: UsageWindow,
): string {
  const DUAL = [
    "⠀",
    "▘",
    "▝",
    "▀",
    "▖",
    "▌",
    "▞",
    "▛",
    "▗",
    "▚",
    "▐",
    "▜",
    "▄",
    "▙",
    "▟",
    "█",
  ];
  const filledSteps = (usedPercent: number): number => {
    const remaining = Math.max(0, 100 - usedPercent);
    return remaining <= 0 ? 0 : Math.max(1, Math.round(remaining / 5));
  };
  const primaryFilled = filledSteps(primary.usedPercent);
  const secondaryFilled = filledSteps(secondary.usedPercent);
  return Array.from({ length: 10 }, (_, index) => {
    const first = index * 2 + 1;
    const second = first + 1;
    const mask =
      (primaryFilled >= first ? 1 : 0) +
      (primaryFilled >= second ? 2 : 0) +
      (secondaryFilled >= first ? 4 : 0) +
      (secondaryFilled >= second ? 8 : 0);
    return DUAL[mask];
  }).join("");
}

export function formatSingleBar(window: UsageWindow): string {
  const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
  const eighths = Math.round((remaining / 100) * 80);
  const fullCells = Math.floor(eighths / 8);
  const partial = eighths % 8;
  const partialBlocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  return (
    "█".repeat(fullCells) +
    partialBlocks[partial] +
    "░".repeat(10 - fullCells - (partial ? 1 : 0))
  );
}

export function formatResetCountdown(
  resetAt: number | undefined,
  now = Date.now(),
): string {
  if (resetAt === undefined) return "";
  const remaining = Math.max(0, resetAt - now);
  if (remaining === 0) return "0s";
  if (remaining > 24 * 60 * 60_000) {
    const totalHours = Math.ceil(remaining / (60 * 60_000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  if (remaining >= 60_000) {
    const totalMinutes = Math.ceil(remaining / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours && minutes
      ? `${hours}h ${minutes}m`
      : hours
        ? `${hours}h`
        : `${minutes}m`;
  }
  return `${Math.floor(remaining / 1000)}s`;
}

async function fetchWeeklyUsage(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<UsageReport | undefined> {
  const result = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
  const token = result?.auth.apiKey;
  if (!token) return undefined;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
  };
  const accountId = accountIdFromToken(token);
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const response = await fetch(USAGE_URL, { headers, signal });
  if (!response.ok) throw new Error(`Codex usage HTTP ${response.status}`);
  return parseUsageReport(await readJsonBounded(response));
}

export default function openAICodexUsageExtension(pi: ExtensionAPI): void {
  let ctx: ExtensionContext | undefined;
  let report: UsageReport | undefined;
  let request: AbortController | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let countdown: ReturnType<typeof setTimeout> | undefined;

  const active = (): boolean =>
    ctx?.hasUI === true && ctx.model?.provider === PROVIDER_ID;
  const setStatus = (): void => {
    if (!ctx || !active() || !report) {
      ctx?.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    const primary = report.primary;
    const secondary = report.secondary;
    const dual = primary && secondary;
    const window = primary ?? secondary;
    if (!window) return;
    const remainingPercent = (usage: UsageWindow): number =>
      Math.round(Math.max(0, Math.min(100, 100 - usage.usedPercent)));
    const value = dual
      ? formatDualBar(primary, secondary)
      : formatSingleBar(window);
    const percentage = dual
      ? `${remainingPercent(primary)}%/${remainingPercent(secondary)}%`
      : `${remainingPercent(window)}%`;
    const reset = secondary?.resetAt ?? primary?.resetAt;
    const exhausted =
      (dual && (primary.usedPercent >= 100 || secondary.usedPercent >= 100)) ||
      (!dual && window.usedPercent >= 100);
    const countdown = formatResetCountdown(reset);
    const theme = ctx.ui.theme;
    const display = theme.bg(
      exhausted ? "toolErrorBg" : "selectedBg",
      theme.fg("dim", value),
    );
    const status = `${theme.fg("accent", "codex")} ${display}${theme.fg("dim", ` ${percentage}`)}${countdown ? theme.fg("dim", ` ${countdown}`) : ""}`;
    ctx.ui.setStatus(STATUS_KEY, status);
  };

  const scheduleCountdown = (): void => {
    if (countdown) clearTimeout(countdown);
    const reset = report?.secondary?.resetAt ?? report?.primary?.resetAt;
    if (!reset || !active()) return;
    const now = Date.now();
    if (reset <= now) return;
    const remaining = Math.max(0, reset - now);
    let boundary: number;
    if (remaining > 24 * 60 * 60_000)
      boundary =
        remaining - (Math.ceil(remaining / (60 * 60_000)) - 1) * 60 * 60_000;
    else if (remaining >= 60_000)
      boundary = remaining - (Math.ceil(remaining / 60_000) - 1) * 60_000;
    else boundary = remaining - Math.floor(remaining / 1000) * 1000;
    countdown = setTimeout(() => {
      setStatus();
      scheduleCountdown();
    }, boundary + 1);
  };

  const refresh = async (ctx: ExtensionContext): Promise<void> => {
    if (!active() || request) return;
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const next = await fetchWeeklyUsage(ctx, controller.signal);
      if (next) {
        report = next;
        setStatus();
        scheduleCountdown();
      }
    } catch {
    } finally {
      clearTimeout(timeout);
      if (request === controller) request = undefined;
    }
  };

  const update = async (
    next: ExtensionContext,
    immediate = false,
  ): Promise<void> => {
    ctx = next;
    if (!active()) {
      request?.abort();
      if (poll) clearInterval(poll);
      if (countdown) clearTimeout(countdown);
      poll = undefined;
      countdown = undefined;
      setStatus();
      return;
    }
    if (!poll)
      poll = setInterval(() => {
        if (ctx) void refresh(ctx);
      }, POLL_MS);
    setStatus();
    scheduleCountdown();
    if (immediate) await refresh(next);
  };

  pi.on("session_start", async (_event, next) => update(next, true));

  pi.on("session_tree", async (_event, next) => update(next));

  pi.on("model_select", async (_event, next) => update(next, true));

  pi.on("session_shutdown", async () => {
    request?.abort();
    request = undefined;
    if (poll) clearInterval(poll);
    if (countdown) clearTimeout(countdown);
    poll = undefined;
    countdown = undefined;
    ctx?.ui.setStatus(STATUS_KEY, undefined);
    ctx = undefined;
    report = undefined;
  });
}
