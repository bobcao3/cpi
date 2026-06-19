/**
 * Shell → agents bridge: extract `cd <dir>` targets from a parsed bash command
 * and surface their unseen AGENTS.md/CLAUDE.md context files.
 *
 * The shell tool uses this so that `cd /proj && ...` loads /proj's project
 * context — mirroring what `set_cwd` does explicitly. pi never reloads
 * context files on cwd change, so trees entered only via a shell `cd` would
 * otherwise stay invisible to the agent.
 *
 * Targets are resolved sequentially against the live cwd, so chained relative
 * `cd`s resolve correctly (e.g. `cd /a && cd sub` → /a then /a/sub).
 *
 * Limitations (intentional, to avoid false path resolution):
 *   - Only the first argument of each `cd` is considered.
 *   - `cd` with no argument, `cd -`, and any target containing `$` or a
 *     backtick (variables / command substitution) are skipped — they cannot
 *     be resolved to a literal path without running the shell.
 *
 * Note: a shell `cd` only moves the child bash process's cwd, not pi's
 * process cwd — so this surfaces context without side-effecting `getCwd()`.
 */

import type { JsonNode as Node } from "./parse.ts";
import { getCwd } from "../lib/cwd.ts";
import { surfaceNewAgents, type AgentsFile } from "../lib/agents.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CD = "cd";

function commandName(cmd: Node): string {
  return cmd.childForFieldName("name")?.text ?? "";
}

/** First literal path argument of a `cd`, or null if it should be skipped. */
function firstLiteralArg(cmd: Node): string | null {
  for (const ch of cmd.namedChildren) {
    if (ch.type === "command_name") continue;
    const t = ch.text;
    if (!t || t === "-") return null;
    if (/[`$]/.test(t)) return null; // variable / substitution — unresolvable
    return t;
  }
  return null;
}

function extractCdTargets(root: Node | null): string[] {
  if (!root) return [];
  const targets: string[] = [];
  for (const cmd of root.descendantsOfType("command")) {
    if (commandName(cmd) !== CD) continue;
    const arg = firstLiteralArg(cmd);
    if (arg !== null) targets.push(arg);
  }
  return targets;
}

/** Resolve a `cd` argument to an absolute path relative to `base`. */
function resolveCdTarget(base: string, arg: string): string {
  if (arg === "~") return homedir();
  if (arg.startsWith("~/")) return join(homedir(), arg.slice(2));
  return isAbsolute(arg) ? arg : resolve(base, arg);
}

/**
 * Surface unseen AGENTS.md/CLAUDE.md files for every `cd <dir>` in a parsed
 * command. Returns the files in source order (root-first per target).
 */
export function surfaceCdAgents(root: Node | null): AgentsFile[] {
  const targets = extractCdTargets(root);
  if (targets.length === 0) return [];
  let cur = getCwd();
  const surfaced: AgentsFile[] = [];
  for (const arg of targets) {
    cur = resolveCdTarget(cur, arg);
    surfaced.push(...surfaceNewAgents(cur));
  }
  return surfaced;
}
