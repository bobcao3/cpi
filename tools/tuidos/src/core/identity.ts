import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Who is the current user? tuidos has no accounts: until the P2P peer-id
 * identity lands, a record's author is the VCS identity — the same source git
 * and jujutsu use for commit authors. This mirrors git's own resolution: read
 * `user.name` / `user.email` from VCS config, and when neither has both, fall
 * back to `user@hostname` (exactly git's fallback) and let the caller warn.
 *
 * Resolution is a read-only config lookup, not a mutation: it never writes and
 * never throws — a missing identity is a normal fallback path, not a crash.
 */

export type IdentitySource = "git" | "jj" | "fallback";

/** The current user's identity. `source` lets callers warn when it was guessed. */
export interface Identity {
  name: string;
  email: string;
  source: IdentitySource;
}

// Defensive bounds (TigerStyle — bound everything): cap absurd config values
// before they reach a free-form TEXT column or the display, and strip the
// delimiters that would break the "Name <email>" form or inject newlines.
const NAME_MAX = 128;
const EMAIL_MAX = 256;
// Bound for an optional author-name suffix (an agent id). The combined
// "name+suffix" is still capped at NAME_MAX, so a suffix never grows the
// stored author past the name limit.
const SUFFIX_MAX = 64;
const CMD_TIMEOUT_MS = 2000;

/** Read one config value from a VCS CLI. Returns the trimmed stdout, or null
 *  when the key is unset, the CLI is absent, or the call fails or times out. */
function configGet(cmd: string, args: string[]): string | null {
  let r;
  try {
    r = spawnSync(cmd, args, { encoding: "utf8", timeout: CMD_TIMEOUT_MS });
  } catch {
    return null;
  }
  if (r.error || r.signal || r.status !== 0) return null;
  const v = (r.stdout ?? "").trim();
  return v || null;
}

/** Strip angle brackets and newlines from a name; collapse whitespace. */
function cleanName(s: string): string {
  return s.replace(/[<>\r\n]/g, " ").replace(/\s+/g, " ").trim();
}

/** Strip angle brackets and newlines from an email (kept bare for `<...>`). */
function cleanEmail(s: string): string {
  return s.replace(/[<>\r\n]/g, "").trim();
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Strip delimiters and newlines from an author-name suffix (an agent id) and
 *  collapse whitespace — the same hazards cleanName/cleanEmail guard against,
 *  so a suffix can't break the "Name <email>" form or inject lines. */
function cleanSuffix(s: string): string {
  return s.replace(/[<>\r\n]/g, "").replace(/\s+/g, " ").trim();
}

/** The optional author-name suffix, read from the environment. Set by the
 *  `--author-suffix` global flag (clidos/index.ts) or directly by an agent
 *  runtime (the orchestrator exports it per worker). When present the author
 *  reads as "Name+suffix <email>": the email — the future P2P peer-id key — is
 *  untouched, so the suffix marks the agent without forking identity. Returns
 *  null when unset or empty after cleaning (no suffix to apply). */
function authorSuffix(): string | null {
  const raw = process.env.TUIDOS_AUTHOR_SUFFIX;
  if (!raw) return null;
  const s = cleanSuffix(raw);
  return s ? cap(s, SUFFIX_MAX) : null;
}

/** A complete, sanitized pair from a VCS, or null if that VCS lacks either
 *  key. A partial pair is treated as absent (see resolveIdentity). */
function vcsPair(cmd: string, nameArgs: string[], emailArgs: string[], source: IdentitySource): Identity | null {
  const name = configGet(cmd, nameArgs);
  const email = configGet(cmd, emailArgs);
  if (!name || !email) return null;
  return { name: cap(cleanName(name), NAME_MAX), email: cap(cleanEmail(email), EMAIL_MAX), source };
}

/** Build a `user@hostname` identity from the OS — git's own fallback when no
 *  user.name/user.email is configured. Every call is guarded: identity
 *  resolution never throws, even on odd platforms. */
function fallbackIdentity(): Identity {
  let user = "user";
  try { user = os.userInfo().username || "user"; } catch { /* keep default */ }
  let host = "localhost";
  try { host = os.hostname() || "localhost"; } catch { /* keep default */ }
  return { name: user, email: `${user}@${host}`, source: "fallback" };
}

let cached: Identity | null = null;

/**
 * Resolve the current user's identity. Prefers a complete `user.name` +
 * `user.email` pair from git config, then jujutsu config; if neither has both,
 * falls back to `user@hostname`. A partial pair from one VCS does NOT borrow
 * from the other — a half-configured identity is treated as unconfigured so
 * the warning steers the user to set both keys rather than silently mixing
 * sources. When `TUIDOS_AUTHOR_SUFFIX` is set (by the `--author-suffix` flag
 * or an agent runtime), it is appended to the name as `name+suffix` so an
 * agent reads as "User+agent_id"; the email — the future P2P peer-id key — is
 * never modified. Memoized: the environment does not change within a process.
 */
export function resolveIdentity(): Identity {
  if (cached) return cached;
  const id = vcsPair("git", ["config", "--get", "user.name"], ["config", "--get", "user.email"], "git")
    ?? vcsPair("jj", ["config", "get", "user.name"], ["config", "get", "user.email"], "jj")
    ?? fallbackIdentity();
  const suffix = authorSuffix();
  if (suffix) id.name = cap(`${id.name}+${suffix}`, NAME_MAX);
  cached = id;
  return cached;
}

/** The canonical VCS author string — "Name <email>", the same form git and
 *  jujutsu use for commit authors. Stored as card_messages.author. */
export function authorString(id: Identity): string {
  return `${id.name} <${id.email}>`;
}

/** One-line fallback warning: the fact plus the placeholder in use. Shared so
 *  every client warns with the same wording. */
export function fallbackWarning(id: Identity): string {
  return `no user.name/user.email in git or jujutsu config — using ${id.email} as your identity`;
}

/** Remedy instructions for the fallback warning (printed by CLI clients). */
export function fallbackRemedy(): string {
  return 'Set it with: git config --global user.name "Your Name" && git config --global user.email "you@example.com"\n'
    + '(or jujutsu: jj config set --user user.name "Your Name" && jj config set --user user.email "you@example.com")';
}
