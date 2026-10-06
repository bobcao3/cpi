import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isRecord } from "./source.ts";

const AUTH_LIMIT_BYTES = 64 * 1024;

export function token_claims(
  token: unknown,
): Record<string, unknown> | undefined {
  if (typeof token !== "string" || token.length > AUTH_LIMIT_BYTES)
    return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    return isRecord(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

export function token_account_id(token: string): string | undefined {
  const auth = token_claims(token)?.["https://api.openai.com/auth"];
  const account = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof account === "string" && account.length > 0
    ? account
    : undefined;
}

// Codex owns token rotation; this reader never refreshes or writes its credentials.
export async function read_codex_cli_token(): Promise<string | undefined> {
  const directory = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const file = await open(join(directory, "auth.json"), "r").catch(
    () => undefined,
  );
  if (!file) return undefined;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > AUTH_LIMIT_BYTES) return undefined;
    const buffer = Buffer.alloc(AUTH_LIMIT_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > AUTH_LIMIT_BYTES) return undefined;
    const payload = JSON.parse(buffer.toString("utf8", 0, bytesRead));
    if (!isRecord(payload) || !isRecord(payload.tokens)) return undefined;
    if (payload.auth_mode !== undefined && payload.auth_mode !== "chatgpt")
      return undefined;
    if (payload.OPENAI_API_KEY) return undefined;
    const token = payload.tokens.access_token;
    const claims = token_claims(token);
    if (
      typeof token !== "string" ||
      typeof claims?.exp !== "number" ||
      !Number.isFinite(claims.exp)
    )
      return undefined;
    if (claims.exp * 1000 <= Date.now()) return undefined;
    const account = token_account_id(token);
    if (
      !account ||
      (payload.tokens.account_id !== undefined &&
        payload.tokens.account_id !== account)
    )
      return undefined;
    return token;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}
