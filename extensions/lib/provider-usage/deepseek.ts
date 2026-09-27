import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchJson, isRecord, type UsageSource } from "./source.ts";

const PROVIDER_ID = "deepseek";
const DEFAULT_BASE_URL = "https://api.deepseek.com";
const BALANCE_PATH = "/user/balance";
const CURRENCY_SYMBOLS: Record<string, string> = { USD: "$", CNY: "¥" };

export interface BalanceReport {
  currency: string;
  total: number;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseBalance(payload: unknown): BalanceReport | undefined {
  if (!isRecord(payload)) return undefined;
  const infos = payload.balance_infos;
  if (!Array.isArray(infos)) return undefined;
  for (const info of infos) {
    if (!isRecord(info)) continue;
    const currency = info.currency;
    const total = toFiniteNumber(info.total_balance);
    if (typeof currency === "string" && currency !== "" && total !== undefined)
      return { currency, total };
  }
  return undefined;
}

export function formatBalance(balance: BalanceReport): string {
  const symbol = CURRENCY_SYMBOLS[balance.currency] ?? `${balance.currency} `;
  return `deepseek ${symbol}${balance.total.toFixed(2)}`;
}

async function fetchBalance(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<BalanceReport | undefined> {
  const token = (await ctx.modelRegistry.getProviderAuth(PROVIDER_ID))?.auth
    .apiKey;
  if (!token) return undefined;
  const base = ctx.model?.baseUrl ?? DEFAULT_BASE_URL;
  const url = new URL(BALANCE_PATH, base);
  return parseBalance(await fetchJson(url.href, token, signal));
}

export const deepseekBalance: UsageSource<BalanceReport> = {
  providers: [PROVIDER_ID],
  fetch: fetchBalance,
  format: formatBalance,
};
