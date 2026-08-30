import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const SUBAGENT_GUIDE_FILE = "subagent-models.md";
export const SUBAGENT_SKILL_NAME = "subagents-in-pi";
const GUIDE_MAX_BYTES = 262_144;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export function subagentModelEfforts(
  reasoning: boolean,
  thinkingLevelMap: unknown,
  pinnedThinkingLevel?: string,
): string[] {
  if (pinnedThinkingLevel !== undefined) return [pinnedThinkingLevel];
  if (!reasoning) return [];

  const map =
    typeof thinkingLevelMap === "object" && thinkingLevelMap !== null
      ? (thinkingLevelMap as Record<string, unknown>)
      : undefined;

  return THINKING_LEVELS.filter((level) => {
    const mapped = map?.[level];
    if (level === "xhigh" || level === "max") {
      return mapped !== undefined && mapped !== null;
    }
    return mapped !== null;
  });
}

export interface SubagentModelGuide {
  path: string;
  text: string;
}

export type SubagentGuideScope = "user" | "project";

function readGuide(path: string): SubagentModelGuide | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > GUIDE_MAX_BYTES) {
      process.stderr.write(
        `[subagent-models] ignoring invalid guide: ${path}\n`,
      );
      return undefined;
    }
    const text = readFileSync(path, "utf8").trim();
    return text ? { path, text } : undefined;
  } catch (error) {
    process.stderr.write(
      `[subagent-models] failed to read ${path}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return undefined;
  }
}

export function subagentGuidePath(
  cwd: string,
  scope: SubagentGuideScope,
  agentDir: string = getAgentDir(),
): string {
  return scope === "project"
    ? join(cwd, CONFIG_DIR_NAME, SUBAGENT_GUIDE_FILE)
    : join(agentDir, SUBAGENT_GUIDE_FILE);
}

export function findSubagentModelGuide(
  cwd: string,
  projectTrusted: boolean,
  agentDir: string = getAgentDir(),
): SubagentModelGuide | undefined {
  if (projectTrusted) {
    const project = readGuide(subagentGuidePath(cwd, "project", agentDir));
    if (project) return project;
  }
  return readGuide(subagentGuidePath(cwd, "user", agentDir));
}
