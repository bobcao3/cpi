import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getAgentDir,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";

const MAX_RULE_BYTES = 131072;

interface RuleFile {
  path: string;
  content: string;
}

function loadRule(path: string): RuleFile | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(stat.size, MAX_RULE_BYTES));
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (count === 0) break;
      bytes += count;
    }
    const content = buffer.toString("utf8", 0, bytes);
    return {
      path,
      content:
        stat.size > MAX_RULE_BYTES ? `${content}\n... (truncated)` : content,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function listRules(dir: string): RuleFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: RuleFile[] = [];
  for (const name of names
    .filter((n) => n.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b))) {
    const rule = loadRule(join(dir, name));
    if (rule) out.push(rule);
  }
  return out;
}

export function loadRulesContext(cwd: string): {
  user: RuleFile[];
  project: RuleFile[];
} {
  return {
    user: listRules(join(getAgentDir(), "rules")),
    project: listRules(join(cwd, ".pi", "rules")),
  };
}

export function withRulesContext(
  contextFiles: BuildSystemPromptOptions["contextFiles"],
  cwd: string,
): NonNullable<BuildSystemPromptOptions["contextFiles"]> {
  const files = contextFiles ?? [];
  const seen = new Set(files.map((file) => file.path));
  const { user, project } = loadRulesContext(cwd);
  const added = new Set<string>();
  const unseen = (rule: RuleFile) => {
    if (seen.has(rule.path) || added.has(rule.path)) return false;
    added.add(rule.path);
    return true;
  };
  const globalIndex = files.findIndex(
    (file) => resolve(dirname(file.path)) === resolve(getAgentDir()),
  );
  const merged = [...files];
  merged.splice(globalIndex + 1, 0, ...user.filter(unseen));
  merged.push(...project.filter(unseen));
  return merged;
}
