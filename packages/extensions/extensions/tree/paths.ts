import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

function normalizePath(input: string, toolInput = false): string {
  let value = toolInput
    ? input
        .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
        .replace(/^@/, "")
    : input;
  if (
    process.platform === "win32" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\")
  ) {
    const match = value.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (match)
      value = `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (value === "~") return homedir();
  if (
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  )
    return join(homedir(), value.slice(2));
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

export function resolvePath(input: string, cwd: string): string {
  return resolve(normalizePath(cwd), normalizePath(input));
}

export function resolveToCwd(input: string, cwd: string): string {
  return resolve(normalizePath(cwd), normalizePath(input, true));
}

export function formatPathRelativeToCwdOrAbsolute(
  input: string,
  cwd: string,
): string {
  const absolute = resolvePath(input, cwd);
  const tail = relative(resolvePath(cwd, cwd), absolute);
  const inside =
    tail !== ".." && !tail.startsWith(`..${sep}`) && !isAbsolute(tail);
  return (inside ? tail || "." : absolute).split(sep).join("/");
}
