/**
 * Bridge shell `cd`s to AGENTS.md context: pi only reloads context on explicit set_cwd, so trees entered via a shell `cd` stay invisible.
 */

import type { JsonNode as Node } from "../lib/tree-sitter.ts";
import { getCwd } from "../lib/cwd.ts";
import { surfaceNewAgents, type AgentsFile } from "../lib/agents.ts";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CD = "cd";

function commandName(cmd: Node): string {
  return cmd.childForFieldName("name")?.text ?? "";
}

function firstLiteralArg(cmd: Node): string | null {
  for (const ch of cmd.namedChildren) {
    if (ch.type === "command_name") continue;
    const t = ch.text;
    if (!t || t === "-") return null;
    if (/[`$]/.test(t)) return null;
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

function resolveCdTarget(base: string, arg: string): string {
  if (arg === "~") return homedir();
  if (arg.startsWith("~/")) return join(homedir(), arg.slice(2));
  return isAbsolute(arg) ? arg : resolve(base, arg);
}

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
