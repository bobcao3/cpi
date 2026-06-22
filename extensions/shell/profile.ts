/**
 * Resolve the interpreter used by the shell tools and its Shuck dialect.
 *
 * The shell executable and the linter dialect are one contract: a command
 * launched as `/bin/sh` must not be linted as Bash merely because Bash is
 * available on the host. `executable = "auto"` follows the host login shell
 * (falling back to Bash when `$SHELL` is absent or unusable), while an explicit
 * executable is resolved deterministically and fails closed if it is not an
 * executable regular file — never silently swapped for Bash.
 *
 * Resolution snapshots the executable to an absolute path at resolution time so
 * a later `process.chdir` / `set_cwd` cannot change which file runs. The
 * invoked path (e.g. `/bin/sh`, possibly a symlink) is preserved for execution;
 * `realpath` is consulted only to detect the implementation/dialect.
 */

import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";

export type ShellDialect = "sh" | "bash" | "zsh" | "mksh";

export interface ShellProfile {
  executable: string;
  argvPrefix: string[];
  dialect: ShellDialect | null;
  displayName: string;
  invocation: string;
}

const FALLBACK_SHELL = "bash";
const KNOWN_BASH = ["/bin/bash", "/usr/bin/bash"];
const MAX_CANDIDATE_LEN = 4096;
const MAX_PATH_ENTRIES = 256;
const MAX_PATH_LEN = 65536; // total $PATH string length bound, before any splitting
const MAX_PATH_ENTRY_LEN = 4096;
const POSIX_NAMES = new Set(["sh", "dash", "ash", "busybox"]);

/** Configuration error thrown when an explicit shell executable is unusable. */
export class ShellConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellConfigError";
  }
}

/** True iff `path` is an executable regular file (symlinks are followed). */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** Reject an empty, NUL-bearing, or oversized explicit executable string. */
function assertValidCandidate(candidate: string): void {
  if (!candidate) throw new ShellConfigError("shell executable is empty");
  if (candidate.includes("\0")) throw new ShellConfigError("shell executable contains a NUL byte");
  if (candidate.length > MAX_CANDIDATE_LEN)
    throw new ShellConfigError(`shell executable exceeds ${MAX_CANDIDATE_LEN} characters`);
}

/** Resolve a path-like candidate (contains a separator) to an absolute path. */
function resolvePathLike(candidate: string): string | null {
  const full = resolve(candidate);
  return isExecutableFile(full) ? full : null;
}

/** Resolve a bare command name to a stable absolute path via a bounded `$PATH` scan. */
function resolveBare(name: string, env: NodeJS.ProcessEnv): string | null {
  const path = env.PATH ?? "";
  if (path.length > MAX_PATH_LEN) return null;
  let start = 0;
  for (let i = 0; i < MAX_PATH_ENTRIES && start <= path.length; i++) {
    let end = path.indexOf(delimiter, start);
    if (end === -1) end = path.length;
    const len = end - start;
    const next = end + 1;
    if (len > MAX_PATH_ENTRY_LEN) {
      start = next;
      continue;
    }
    const entry = len === 0 ? "." : path.slice(start, end);
    start = next;
    const full = resolve(entry, name);
    if (isExecutableFile(full)) return full;
  }
  return null;
}

function resolveExecutable(candidate: string, env: NodeJS.ProcessEnv): string | null {
  if (!candidate || candidate.includes("\0") || candidate.length > MAX_CANDIDATE_LEN) return null;
  if (candidate.includes("/") || candidate.includes("\\")) return resolvePathLike(candidate);
  return resolveBare(candidate, env);
}

/** Bash fallback for `auto`: `$PATH` first, then well-known locations. */
function resolveBash(env: NodeJS.ProcessEnv): string | null {
  return resolveBare(FALLBACK_SHELL, env) ?? KNOWN_BASH.find(isExecutableFile) ?? null;
}

function failExplicit(candidate: string): never {
  throw new ShellConfigError(
    `shell executable ${JSON.stringify(candidate)} is not an executable regular file`,
  );
}

function failAuto(): never {
  throw new ShellConfigError(
    `no usable shell: $SHELL is absent or unusable and ${FALLBACK_SHELL} was not found on $PATH or at ${KNOWN_BASH.join(" or ")}`,
  );
}

function realName(path: string): string {
  try {
    return basename(realpathSync(path))
      .replace(/\.exe$/i, "")
      .toLowerCase();
  } catch {
    return basename(path)
      .replace(/\.exe$/i, "")
      .toLowerCase();
  }
}

function invokedName(path: string): string {
  return basename(path)
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

function dialectFor(invoked: string, canonical: string): ShellDialect | null {
  if (POSIX_NAMES.has(invoked)) return "sh";
  if (invoked === "bash") return "bash";
  if (invoked === "zsh") return "zsh";
  if (invoked === "mksh") return "mksh";
  if (POSIX_NAMES.has(canonical)) return "sh";
  if (canonical === "bash") return "bash";
  if (canonical === "zsh") return "zsh";
  if (canonical === "mksh") return "mksh";
  return null;
}

function displayName(invoked: string, canonical: string, dialect: ShellDialect | null): string {
  if (canonical === "busybox") return `busybox ${invoked === "busybox" ? "sh" : invoked}`;
  if (dialect === "sh") {
    const implementation = canonical === "sh" ? invoked : canonical;
    return `${implementation} (POSIX sh)`;
  }
  return invoked || canonical || "shell";
}

/**
 * Resolve a shell executable. `auto` (the default) follows `$SHELL` and falls
 * back to Bash when it is absent or unusable; an explicit executable is
 * validated and fails closed with a {@link ShellConfigError} if unusable.
 */
export function resolveShell(
  requested: string | undefined = "auto",
  env: NodeJS.ProcessEnv = process.env,
): ShellProfile {
  const configured = (requested ?? "").trim();
  const isAuto = configured === "auto";
  let executable: string;
  if (isAuto) {
    const shellEnv = env.SHELL?.trim() || "";
    executable = resolveExecutable(shellEnv, env) ?? resolveBash(env) ?? failAuto();
  } else {
    assertValidCandidate(configured);
    executable = resolveExecutable(configured, env) ?? failExplicit(configured);
  }
  const invoked = invokedName(executable);
  const canonical = realName(executable);
  const dialect = dialectFor(invoked, canonical);
  const display = displayName(invoked, canonical, dialect);
  const argvPrefix = canonical === "busybox" && invoked === "busybox" ? ["sh"] : [];
  const invocation = argvPrefix.length > 0 ? "busybox sh -c" : `${invoked} -c`;
  return { executable, argvPrefix, dialect, displayName: display, invocation };
}
