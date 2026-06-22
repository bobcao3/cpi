/**
 * Bounded dotenv parser (deterministic, no `${}` interpolation).
 *
* Shared read side for `sh env=` / `sh_repeat_until env=` / `lsp env=` and the
* server spawn env. `bin/env-capture` writes plain `KEY=VALUE` lines this parser
* reads back losslessly for the common (unquoted, unexported) case.
 *
 * Explicit limits (TigerStyle): 256 KiB file, 4096 keys, 32 KiB value.
 * Semantics: skip blank + `#`-comment lines; strip a leading `export `; strip a
 * single matching surrounding `"` / `'`; split on the first `=`. Keys not
 * matching `[A-Za-z_][A-Za-z0-9_]*` are skipped (negative space). Pure node —
 * no pi/ExtensionAPI import.
 */

import { readFileSync, statSync } from "node:fs";

export const DOTENV_MAX_FILE_BYTES = 256 * 1024;
export const DOTENV_MAX_KEYS = 4096;
export const DOTENV_MAX_VALUE_BYTES = 32 * 1024;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Strip one matching surrounding single/double quote pair. No escape handling. */
function stripQuotes(v: string): string {
  if (v.length < 2) return v;
  const q = v[0];
  if ((q === '"' || q === "'") && v[v.length - 1] === q) return v.slice(1, -1);
  return v;
}

/** Truncate to `maxBytes` UTF-8 bytes without splitting a trailing codepoint. */
function truncateBytes(v: string, maxBytes: number): string {
  if (Buffer.byteLength(v, "utf8") <= maxBytes) return v;
  return Buffer.from(v, "utf8").subarray(0, maxBytes).toString("utf8");
}

/**
 * Parse a dotenv file into a string map. Throws on missing file or over-limit
 * (file > 256 KiB, keys > 4096) so callers surface a clean error rather than
 * silently truncating state.
 */
export function parseDotEnv(filePath: string): Record<string, string> {
  assert(
    typeof filePath === "string" && filePath.length > 0,
    "parseDotEnv: path must be a non-empty string",
  );

  let size: number;
  try {
    size = statSync(filePath).size;
  } catch (err) {
    throw new Error(`parseDotEnv: cannot stat ${filePath}: ${(err as Error).message}`);
  }
  assert(Number.isFinite(size) && size >= 0, `parseDotEnv: bad file size ${size}`);
  if (size > DOTENV_MAX_FILE_BYTES) {
    throw new Error(
      `parseDotEnv: file too large (${size} > ${DOTENV_MAX_FILE_BYTES} bytes): ${filePath}`,
    );
  }

  const src = readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");
  const out: Record<string, string> = {};
  for (const raw of src.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    let rest = trimmed;
    if (rest.startsWith("export ")) rest = rest.slice("export ".length).trimStart();
    const eq = rest.indexOf("=");
    if (eq <= 0) continue;
    const key = rest.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    out[key] = truncateBytes(stripQuotes(rest.slice(eq + 1)), DOTENV_MAX_VALUE_BYTES);
    if (Object.keys(out).length > DOTENV_MAX_KEYS) {
      throw new Error(`parseDotEnv: too many keys (>${DOTENV_MAX_KEYS}): ${filePath}`);
    }
  }
  assert(Object.keys(out).length <= DOTENV_MAX_KEYS, "parseDotEnv: key-count invariant breached");
  return out;
}
