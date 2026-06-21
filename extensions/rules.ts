/**
 * Rules extension
 *
 * Discovers markdown files in two scopes and appends them to the system
 * prompt every turn:
 *
 *   - User scope:  ~/.pi/agent/rules/*.md
 *   - Project scope: <cwd>/rules/*.md
 *
 * Each file is surfaced as:
 *
 *   --- <label>/<file>.md ---
 *   <content>
 *
 * Project rules are appended after user rules so project specifics take
 * precedence. The transform is applied by the single system-prompt owner in
 * core.ts; this extension only registers a transform.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerSystemPromptTransform } from "./lib/system-prompt.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const USER_RULES_DIR = join(homedir(), ".pi", "agent", "rules");
const PROJECT_RULES_DIR_NAME = "rules";
const TRANSFORM_ORDER = 150; // after strip-skills (100), before caveman (200)
const MAX_RULE_BYTES = 131072;
const CACHE_KEY = "__cpiRulesCache";

interface RuleFile {
  label: string;
  content: string;
}

interface RulesCache {
  signature: string;
  block: string;
}

function cache(): RulesCache | undefined {
  return (globalThis as Record<string, unknown>)[CACHE_KEY] as RulesCache | undefined;
}

function setCache(entry: RulesCache): void {
  (globalThis as Record<string, unknown>)[CACHE_KEY] = entry;
}

function dirSignature(dir: string): string {
  if (!existsSync(dir)) return `${dir}:missing`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return `${dir}:unreadable`;
  }
  const parts: string[] = [dir];
  for (const name of names.filter((n) => n.endsWith(".md")).sort((a, b) => a.localeCompare(b))) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (st.isFile()) parts.push(`${name}:${st.mtimeMs}:${st.size}`);
    } catch {
      // ignore unreadable entries
    }
  }
  return parts.join("|");
}

function loadRule(path: string, label: string): RuleFile | null {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (content.length > MAX_RULE_BYTES) {
    content = content.slice(0, MAX_RULE_BYTES) + "\n... (truncated)";
  }
  return { label, content };
}

function listRules(dir: string, labelPrefix: string): RuleFile[] {
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RuleFile[] = [];
  for (const name of names.filter((n) => n.endsWith(".md")).sort((a, b) => a.localeCompare(b))) {
    const path = join(dir, name);
    try {
      if (!statSync(path).isFile()) continue;
    } catch {
      continue;
    }
    const rule = loadRule(path, `${labelPrefix}/${name}`);
    if (rule) out.push(rule);
  }
  return out;
}

function buildRulesBlock(files: RuleFile[]): string {
  if (files.length === 0) return "";
  let block = "\n\n";
  for (const f of files) {
    block += `--- ${f.label} ---\n${f.content}\n`;
  }
  return block;
}

export default function rulesExtension(_pi: ExtensionAPI): void {
  registerSystemPromptTransform(
    "cpi-rules",
    (systemPrompt) => {
      const projectDir = join(process.cwd(), PROJECT_RULES_DIR_NAME);
      const signature = `${dirSignature(USER_RULES_DIR)};${dirSignature(projectDir)}`;

      const cached = cache();
      if (cached && cached.signature === signature) {
        return cached.block ? systemPrompt + cached.block : systemPrompt;
      }

      const files = [...listRules(USER_RULES_DIR, "user-rules"), ...listRules(projectDir, "rules")];
      const block = buildRulesBlock(files);
      setCache({ signature, block });

      return block ? systemPrompt + block : systemPrompt;
    },
    TRANSFORM_ORDER,
  );
}
