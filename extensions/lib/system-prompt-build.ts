/**
 * cpi system-prompt builder — fully replaces pi-core's buildSystemPrompt.
 *
 * Why cpi owns this instead of relying on pi-core + a transform:
 *   1. Drops the redundant "Available tools" prose list. The model already
 *      receives full tool schemas (name + description + parameters) via the
 *      provider's `tools` parameter (Anthropic inlines them into the prompt
 *      prefix; OpenAI-compat chat templates inject them too), so a one-line
 *      duplicate listing is pure token waste.
 *   2. Drops the `<available_skills>` block. The skill tool's own `description`
 *      already enumerates available skills dynamically, so the block is also
 *      redundant. (The skill extension's `strip-skills` transform is now a
 *      harmless no-op, left in place.)
 *   3. Uses the LIVE cwd from lib/cwd.ts (follows `set_cwd`) instead of pi's
 *      startup snapshot, so "Current working directory" stays correct after
 *      the agent moves between projects/trees.
 *
 * Invoked once per turn from the core extension's `before_agent_start`, then
 * the registered transforms (cpi-rules, caveman, llm-editor) apply on top.
 */
import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { getCwd } from "./cwd.ts";

function dateStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function contextBlock(files: { path: string; content: string }[]): string {
  if (files.length === 0) return "";
  let out = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    out += `<file path="${path}">\n${content}\n</file>\n\n`;
  }
  out += "</project_context>";
  return out;
}

function defaultPrompt(guidelines: string[]): string {
  const g = guidelines.length > 0 ? guidelines.map((x) => `- ${x}`).join("\n") : "(none)";
  return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Guidelines:
${g}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${getReadmePath()}
- Additional docs: ${getDocsPath()}
- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)`;
}

/** Build cpi's system prompt from `systemPromptOptions`. Replaces pi-core's. */
export function buildCpiSystemPrompt(options: BuildSystemPromptOptions): string {
  const { customPrompt, promptGuidelines, appendSystemPrompt, contextFiles = [] } = options;

  // Per-tool guidelines from TOMLs, pruned of empties, plus the always-on baselines.
  const guidelines = (promptGuidelines ?? [])
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  // A custom --system-prompt replaces the identity + guidelines + pi-docs
  // baseline (matching pi-core's contract); everything else is still appended.
  const base = customPrompt ? customPrompt : defaultPrompt(guidelines);

  let prompt = base;
  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;
  prompt += contextBlock(contextFiles);
  prompt += `\n\nCurrent date: ${dateStr()}`;
  prompt += `\nCurrent working directory: ${getCwd().replace(/\\/g, "/")}`;
  return prompt;
}
