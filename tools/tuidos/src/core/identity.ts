import { spawnSync } from "node:child_process";
import os from "node:os";

/**
 * Prefer complete git/jj identity; otherwise use user@hostname without writing or throwing.
 */

export type IdentitySource = "git" | "jj" | "fallback";

export interface Identity {
  name: string;
  email: string;
  source: IdentitySource;
}

const NAME_MAX = 128;
const EMAIL_MAX = 256;
const SUFFIX_MAX = 64;
const CMD_TIMEOUT_MS = 2000;

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

function cleanName(s: string): string {
  return s
    .replace(/[<>\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanEmail(s: string): string {
  return s.replace(/[<>\r\n]/g, "").trim();
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function cleanSuffix(s: string): string {
  return s
    .replace(/[<>\r\n]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function authorSuffix(): string | null {
  const raw = process.env.TUIDOS_AUTHOR_SUFFIX;
  if (!raw) return null;
  const s = cleanSuffix(raw);
  return s ? cap(s, SUFFIX_MAX) : null;
}

function vcsPair(
  cmd: string,
  nameArgs: string[],
  emailArgs: string[],
  source: IdentitySource,
): Identity | null {
  const name = configGet(cmd, nameArgs);
  const email = configGet(cmd, emailArgs);
  if (!name || !email) return null;
  return {
    name: cap(cleanName(name), NAME_MAX),
    email: cap(cleanEmail(email), EMAIL_MAX),
    source,
  };
}

function fallbackIdentity(): Identity {
  let user = "user";
  try {
    user = os.userInfo().username || "user";
  } catch {}
  let host = "localhost";
  try {
    host = os.hostname() || "localhost";
  } catch {}
  return { name: user, email: `${user}@${host}`, source: "fallback" };
}

let cached: Identity | null = null;

/**
 * Resolve the current user's identity. Prefers a complete git pair, then a
 * complete jj pair; a partial pair is treated as unconfigured, never borrowed
 * across VCSs. Falls back to user@hostname. Appends TUIDOS_AUTHOR_SUFFIX to
 * the name when set. Memoized per process.
 */
export function resolveIdentity(): Identity {
  if (cached) return cached;
  const id =
    vcsPair(
      "git",
      ["config", "--get", "user.name"],
      ["config", "--get", "user.email"],
      "git",
    ) ??
    vcsPair(
      "jj",
      ["config", "get", "user.name"],
      ["config", "get", "user.email"],
      "jj",
    ) ??
    fallbackIdentity();
  const suffix = authorSuffix();
  if (suffix) id.name = cap(`${id.name}+${suffix}`, NAME_MAX);
  cached = id;
  return cached;
}

export function authorString(id: Identity): string {
  return `${id.name} <${id.email}>`;
}

export function fallbackWarning(id: Identity): string {
  return `no user.name/user.email in git or jujutsu config — using ${id.email} as your identity`;
}

export function fallbackRemedy(): string {
  return (
    'Set it with: git config --global user.name "Your Name" && git config --global user.email "you@example.com"\n' +
    '(or jujutsu: jj config set --user user.name "Your Name" && jj config set --user user.email "you@example.com")'
  );
}
