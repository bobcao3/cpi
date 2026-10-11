import { getPackageDir, type Skill } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { activePiRoot } from "../../bin/host-pi.mjs";

const HARNESS_ROOT = canonicalPath(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const PREFIXES = ["PI_AGENT_SRC", "CPI_HARNESS_SRC", "HOME"] as const;
let piRoot: string | undefined;

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function within(root: string, path: string): string | undefined {
  const tail = relative(root, path);
  if (tail === "") return "";
  if (tail === ".." || tail.startsWith(`..${sep}`) || isAbsolute(tail))
    return undefined;
  return tail;
}

export function injectSourcePaths(): void {
  if (!piRoot) {
    try {
      piRoot = canonicalPath(activePiRoot());
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !error.message.startsWith("Cannot identify the active Pi package;")
      )
        throw error;
      piRoot = canonicalPath(getPackageDir());
    }
  }
  process.env.PI_AGENT_SRC = piRoot;
  process.env.CPI_HARNESS_SRC = HARNESS_ROOT;
}

export function displaySkillPath(skill: Skill): string {
  injectSourcePaths();
  if (
    skill.sourceInfo.scope === "project" &&
    skill.sourceInfo.origin !== "package"
  )
    return skill.filePath;
  const file = canonicalPath(skill.filePath);
  for (const name of ["CPI_HARNESS_SRC", "PI_AGENT_SRC"] as const) {
    const root = process.env[name];
    if (!root) continue;
    const tail = within(root, file);
    if (tail !== undefined)
      return `$${name}${tail ? `/${tail.split(sep).join("/")}` : ""}`;
  }
  if (skill.sourceInfo.scope === "user") {
    const tail = within(canonicalPath(homedir()), file);
    if (tail !== undefined)
      return `$HOME${tail ? `/${tail.split(sep).join("/")}` : ""}`;
  }
  return skill.filePath;
}

export function expandSourcePath(path: string): string {
  const match = /^\$(PI_AGENT_SRC|CPI_HARNESS_SRC|HOME)(?=\/|$)/.exec(path);
  if (!match) return path;
  injectSourcePaths();
  const name = match[1] as (typeof PREFIXES)[number];
  const root = name === "HOME" ? homedir() : process.env[name];
  if (!root) throw new Error(`Source path is unavailable: ${name}`);
  return resolve(root, `.${path.slice(match[0].length)}`);
}
