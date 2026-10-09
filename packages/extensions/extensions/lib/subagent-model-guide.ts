import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

type AgentMessage = Extract<SessionEntry, { type: "message" }>["message"];

const GUIDE_MARKER = "Active subagent model-selection guide";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsGuide(text: unknown): boolean {
  return typeof text === "string" && text.includes(GUIDE_MARKER);
}

function injectIntoUserMessage(
  message: AgentMessage,
  name: string,
  block: string,
): AgentMessage | undefined {
  if (message.role !== "user") return undefined;
  const pattern = new RegExp(
    `(<skill name="${escapeRegExp(name)}" location="[^"]+">\\n[\\s\\S]*?)(\\n</skill>)`,
  );
  const inject = (text: string): string | undefined => {
    if (containsGuide(text) || !pattern.test(text)) return undefined;
    return text.replace(pattern, `$1\n\n${block}$2`);
  };
  if (typeof message.content === "string") {
    const next = inject(message.content);
    return next === undefined ? undefined : { ...message, content: next };
  }
  let injected = false;
  const content = message.content.map((part) => {
    if (injected || part.type !== "text") return part;
    const next = inject(part.text);
    if (next === undefined) return part;
    injected = true;
    return { ...part, text: next };
  });
  return injected ? { ...message, content } : undefined;
}

function injectIntoReadResult(
  message: AgentMessage,
  filePath: string,
  block: string,
): AgentMessage | undefined {
  if (message.role !== "toolResult" || message.isError) return undefined;
  if (message.toolName !== "read") return undefined;
  const details = message.details as { path?: unknown } | undefined;
  const path = typeof details?.path === "string" ? details.path : undefined;
  if (!path || resolve(path) !== filePath) return undefined;
  if (
    message.content.some(
      (part) => part.type === "text" && containsGuide(part.text),
    )
  )
    return undefined;
  return {
    ...message,
    content: [...message.content, { type: "text", text: `\n\n${block}` }],
  };
}

/**
 * Append the active subagent model-selection guide to the loaded
 * `subagents-in-pi` skill wherever it appears in an outgoing request: in an
 * expanded `<skill>` user message, or in the result of the `read` tool that
 * loaded the skill file. Returns undefined when no message changed.
 */
export function injectSubagentGuide(
  messages: AgentMessage[],
  name: string,
  filePath: string,
  block: string,
): AgentMessage[] | undefined {
  const file = resolve(filePath);
  if (!block.trim()) return undefined;
  let injected = false;
  const out = messages.map((message) => {
    const next =
      injectIntoUserMessage(message, name, block) ??
      injectIntoReadResult(message, file, block);
    if (!next) return message;
    injected = true;
    return next;
  });
  return injected ? out : undefined;
}
