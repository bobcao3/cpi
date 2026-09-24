/** Omits redundant generated sections and uses the live cwd. */
import {
  formatSkillsForPrompt,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { getCwd } from "./cwd.ts";
import { displaySkillPath, injectSourcePaths } from "./skill-paths.ts";
import { loadText, render, textPath } from "./text.ts";

export interface CpiSystemPromptContext extends Record<string, unknown> {
  provider: string;
  modelId: string;
  vision?: boolean;
}

interface SystemPromptText {
  identity: { prompt: string };
  default: { prompt: string };
  guidelines: { always: string[] };
  context: { prompt: string };
  status: { prompt: string };
}

function dateStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function contextBlock(
  template: string,
  files: { path: string; content: string }[],
): string {
  if (files.length === 0) return "";
  return `\n\n${render(template, { files }).trim()}`;
}

function defaultPrompt(
  template: string,
  identity: string,
  guidelines: string[],
  renderCtx: CpiSystemPromptContext,
): string {
  return render(template, {
    ...renderCtx,
    identity,
    guidelines: guidelines.map((x) => `- ${x}`).join("\n"),
  }).trim();
}

export function buildCpiSystemPrompt(
  options: BuildSystemPromptOptions,
  renderCtx: CpiSystemPromptContext,
): string {
  injectSourcePaths();
  const text = loadText<SystemPromptText>(
    "system-prompt",
    textPath("system-prompt"),
  );
  const {
    customPrompt,
    promptGuidelines,
    appendSystemPrompt,
    contextFiles = [],
  } = options;

  const guidelines = (promptGuidelines ?? [])
    .map((g) => render(g, renderCtx).trim())
    .filter((g) => g.length > 0);
  guidelines.push(...text.guidelines.always);
  const identity = render(text.identity.prompt, renderCtx).trim();

  // A custom --system-prompt replaces the identity/guidelines/pi-docs baseline; appended content remains.
  const base = customPrompt
    ? customPrompt
    : defaultPrompt(text.default.prompt, identity, guidelines, renderCtx);

  let prompt = base;
  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;
  prompt += contextBlock(text.context.prompt, contextFiles);
  const readTool = (["read", "bash"] as const).find((tool) =>
    options.selectedTools?.includes(tool),
  );
  if (readTool && options.skills?.length) {
    const nativeSkills = formatSkillsForPrompt(
      options.skills.map((skill) => ({
        ...skill,
        filePath: displaySkillPath(skill),
      })),
      readTool,
    ).trim();
    if (nativeSkills) prompt += `\n\n${nativeSkills}`;
  }
  prompt += `\n\n${render(text.status.prompt, {
    date: dateStr(),
    cwd: getCwd().replace(/\\/g, "/"),
  }).trim()}`;
  return prompt;
}
