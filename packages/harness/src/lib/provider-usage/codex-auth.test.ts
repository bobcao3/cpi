import { test, expect } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { read_codex_cli_token } from "./codex-auth.ts";

function token(exp: number, account: unknown = "account-test"): string {
  const payload = {
    exp,
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  };
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("Codex CLI credentials follow CODEX_HOME and remain read-only across login changes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpi codex auth "));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = directory;
  const path = join(directory, "auth.json");
  const access = token(Date.now() / 1000 + 3600);
  const credentials = {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      access_token: access,
      account_id: "account-test",
      refresh_token: "must-not-refresh",
    },
  };
  try {
    expect(await read_codex_cli_token()).toBeUndefined();
    for (const [name, value, expected] of [
      ["ChatGPT login", credentials, access],
      ["older credential format", { tokens: credentials.tokens }, access],
      [
        "API-key login with leftover tokens",
        { ...credentials, auth_mode: "apikey", OPENAI_API_KEY: "sk-test" },
        undefined,
      ],
      ["unknown auth mode", { ...credentials, auth_mode: "other" }, undefined],
      [
        "expired token",
        {
          ...credentials,
          tokens: { ...credentials.tokens, access_token: token(1) },
        },
        undefined,
      ],
      [
        "workspace mismatch",
        {
          ...credentials,
          tokens: { ...credentials.tokens, account_id: "other-account" },
        },
        undefined,
      ],
      [
        "missing account claim",
        {
          ...credentials,
          tokens: { access_token: token(Date.now() / 1000 + 3600, null) },
        },
        undefined,
      ],
      ["opaque token", { tokens: { access_token: "opaque" } }, undefined],
      ["malformed file", "{", undefined],
      ["oversized file", " ".repeat(1024 * 1024), undefined],
      ["replacement login", credentials, access],
    ] as const) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      await writeFile(path, text, { mode: 0o600 });
      const before = await stat(path);
      expect(await read_codex_cli_token(), name).toBe(expected);
      expect(await readFile(path, "utf8"), name).toBe(text);
      expect((await stat(path)).mtimeMs, name).toBe(before.mtimeMs);
    }
    await rm(path);
    expect(await read_codex_cli_token()).toBeUndefined();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
