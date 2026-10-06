import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  read_codex_cli_token,
  token_account_id,
  token_claims,
} from "./codex-auth.ts";
import { codexUsage, parseUsageReport, type UsageReport } from "./codex.ts";
import { fetchJson, isRecord, type UsageSource } from "./source.ts";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function app_matches(payload: unknown, client_id: string): boolean {
  if (!isRecord(payload) || payload.has_more === true || payload.next_cursor)
    return false;
  if (!Array.isArray(payload.items)) return false;
  return (
    payload.items.filter((item) => isRecord(item) && item.id === client_id)
      .length === 1
  );
}

async function fetch_report(
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<UsageReport | undefined> {
  const native = await ctx.modelRegistry
    .getProviderAuth("openai")
    .catch(() => undefined);
  if (native?.source !== "OAuth") return undefined;
  const client_id = token_claims(native.auth.apiKey)?.client_id;
  if (typeof client_id !== "string" || !client_id) return undefined;
  const companion = await ctx.modelRegistry
    .getProviderAuth("openai-codex")
    .catch(() => undefined);
  const tokens = new Set([
    companion?.source === "OAuth" ? companion.auth.apiKey : undefined,
    await read_codex_cli_token(),
  ]);
  for (const token of tokens) {
    if (signal.aborted) return undefined;
    if (!token) continue;
    const account_id = token_account_id(token);
    if (!account_id) continue;
    try {
      const headers = { "chatgpt-account-id": account_id };
      // App registrations bind the native grant to the companion account without comparing opaque subjects.
      const apps = await fetchJson(
        `${USAGE_URL}/chatpass/apps`,
        token,
        signal,
        headers,
      );
      if (!app_matches(apps, client_id)) continue;
      const payload = await fetchJson(USAGE_URL, token, signal, headers);
      const report = parseUsageReport(payload);
      if (report) return report;
    } catch {
      // Failed credentials must not preserve another account's cached quota.
    }
  }
  return undefined;
}

export const openaiUsage: UsageSource<UsageReport> = {
  providers: ["openai"],
  fetch: fetch_report,
  format: codexUsage.format,
  nextChange: codexUsage.nextChange,
};
