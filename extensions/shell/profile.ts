/** Explicit shells fail closed; auto follows $SHELL, then Bash. The resolved executable is snapshotted to an absolute path. */

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
const MAX_PATH_LEN = 65536;
const MAX_PATH_ENTRY_LEN = 4096;
const POSIX_NAMES = new Set(["sh", "dash", "ash", "busybox"]);

export class ShellConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ShellConfigError";
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function assertValidCandidate(candidate: string): void {
  if (!candidate) throw new ShellConfigError("shell executable is empty");
  if (candidate.includes("\0"))
    throw new ShellConfigError("shell executable contains a NUL byte");
  if (candidate.length > MAX_CANDIDATE_LEN)
    throw new ShellConfigError(
      `shell executable exceeds ${MAX_CANDIDATE_LEN} characters`,
    );
}

function resolvePathLike(candidate: string): string | null {
  const full = resolve(candidate);
  return isExecutableFile(full) ? full : null;
}

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

function resolveExecutable(
  candidate: string,
  env: NodeJS.ProcessEnv,
): string | null {
  if (
    !candidate ||
    candidate.includes("\0") ||
    candidate.length > MAX_CANDIDATE_LEN
  )
    return null;
  if (candidate.includes("/") || candidate.includes("\\"))
    return resolvePathLike(candidate);
  return resolveBare(candidate, env);
}

function resolveBash(env: NodeJS.ProcessEnv): string | null {
  return (
    resolveBare(FALLBACK_SHELL, env) ??
    KNOWN_BASH.find(isExecutableFile) ??
    null
  );
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

function displayName(
  invoked: string,
  canonical: string,
  dialect: ShellDialect | null,
): string {
  if (canonical === "busybox")
    return `busybox ${invoked === "busybox" ? "sh" : invoked}`;
  if (dialect === "sh") {
    const implementation = canonical === "sh" ? invoked : canonical;
    return `${implementation} (POSIX sh)`;
  }
  return invoked || canonical || "shell";
}

export function resolveShell(
  requested: string | undefined = "auto",
  env: NodeJS.ProcessEnv = process.env,
): ShellProfile {
  const configured = (requested ?? "").trim();
  const isAuto = configured === "auto";
  let executable: string;
  if (isAuto) {
    const shellEnv = env.SHELL?.trim() || "";
    executable =
      resolveExecutable(shellEnv, env) ?? resolveBash(env) ?? failAuto();
  } else {
    assertValidCandidate(configured);
    executable = resolveExecutable(configured, env) ?? failExplicit(configured);
  }
  const invoked = invokedName(executable);
  const canonical = realName(executable);
  const dialect = dialectFor(invoked, canonical);
  const display = displayName(invoked, canonical, dialect);
  const argvPrefix =
    canonical === "busybox" && invoked === "busybox" ? ["sh"] : [];
  const invocation = argvPrefix.length > 0 ? "busybox sh -c" : `${invoked} -c`;
  return { executable, argvPrefix, dialect, displayName: display, invocation };
}
