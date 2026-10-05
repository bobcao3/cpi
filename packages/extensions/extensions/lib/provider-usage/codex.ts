import type {
  ExtensionContext,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { mixColors } from "@earendil-works/pi-tui";
import { fetchJson, isRecord, type UsageSource } from "./source.ts";

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const BAR_CELLS = 8;

export interface UsageWindow {
  usedPercent: number;
  resetAt?: number;
}

export interface UsageReport {
  primary?: UsageWindow;
  secondary?: UsageWindow;
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

function resetAtFromWindow(
  window: Record<string, unknown>,
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

function formatBar(
  window: UsageWindow,
  theme: Theme | undefined,
  fill: ThemeColor,
): string {
  const percent = remainingPercent(window);
  const value = `${percent}%`;
  const label = (
    " ".repeat(Math.floor((BAR_CELLS - value.length) / 2)) + value
  ).padEnd(BAR_CELLS);
  const filled =
    percent === 0 ? 0 : Math.max(1, Math.round((percent * BAR_CELLS) / 100));
  const prefix = label.slice(0, filled);
  const suffix = label.slice(filled);
  return theme
    ? (prefix
        ? theme.style(prefix, {
            fg: theme.colors.userMessageBg,
            bg: theme.colors[fill],
          })
        : "") +
        (suffix
          ? theme.style(suffix, {
              fg: "text",
              bg: mixColors(
                theme.colors.customMessageBg,
                theme.colors.text,
                0.28,
              ),
            })
          : "")
    : label;
}

export function formatResetCountdown(
  resetAt: number | undefined,
  now = Date.now(),
): string {
  if (resetAt === undefined) return "";
  const remaining = Math.max(0, resetAt - now);
  if (remaining === 0) return "0s";
  if (remaining > DAY_MS) {
    const totalHours = Math.ceil(remaining / HOUR_MS);
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    return hours ? `${days}d ${hours}h` : `${days}d`;
  }
  if (remaining >= MINUTE_MS) {
    const totalMinutes = Math.ceil(remaining / MINUTE_MS);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return hours && minutes
      ? `${hours}h ${minutes}m`
      : hours
        ? `${hours}h`
        : `${minutes}m`;
  }
  return `${Math.floor(remaining / SECOND_MS)}s`;
}

function remainingPercent(window: UsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, 100 - window.usedPercent)));
}

function format(
  report: UsageReport,
  now: number,
  theme?: Theme,
): string | undefined {
  const { primary, secondary } = report;
  const window = primary ?? secondary;
  if (!window) return undefined;
  const dual = primary !== undefined && secondary !== undefined;
  const tracks = dual
    ? [
        formatBar(primary, theme, "success"),
        formatBar(secondary, theme, "warning"),
      ]
    : [formatBar(window, theme, "success")];
  const reset = secondary?.resetAt ?? primary?.resetAt;
  const countdown = formatResetCountdown(reset, now);
  const prefix = `${PROVIDER_ID} `;
  const suffix = countdown ? ` ${countdown}` : "";
  return (
    (theme ? theme.fg("muted", prefix) : prefix) +
    tracks.join("") +
    (theme ? theme.fg("muted", suffix) : suffix)
  );
}

function nextChange(report: UsageReport, now: number): number | undefined {
  const resetAt = report.secondary?.resetAt ?? report.primary?.resetAt;
  if (resetAt === undefined || resetAt <= now) return undefined;
  const remaining = resetAt - now;
  const boundary =
    remaining > DAY_MS
      ? remaining - (Math.ceil(remaining / HOUR_MS) - 1) * HOUR_MS
      : remaining >= MINUTE_MS
        ? remaining - (Math.ceil(remaining / MINUTE_MS) - 1) * MINUTE_MS
        : remaining - Math.floor(remaining / SECOND_MS) * SECOND_MS;
  return now + boundary + 1;
}

async function fetchReport(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<UsageReport | undefined> {
  const token = (await ctx.modelRegistry.getProviderAuth(PROVIDER_ID))?.auth
    .apiKey;
  if (!token) return undefined;
  const accountId = accountIdFromToken(token);
  const payload = await fetchJson(
    USAGE_URL,
    token,
    signal,
    accountId ? { "chatgpt-account-id": accountId } : undefined,
  );
  return parseUsageReport(payload);
}

export const codexUsage: UsageSource<UsageReport> = {
  providers: [PROVIDER_ID],
  fetch: fetchReport,
  format,
  nextChange,
};
