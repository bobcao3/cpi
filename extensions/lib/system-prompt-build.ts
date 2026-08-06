/** Omits redundant generated sections and uses the live cwd. */
import {
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { getCwd } from "./cwd.ts";
import { render } from "./text.ts";

function dateStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function contextBlock(files: { path: string; content: string }[]): string {
  if (files.length === 0) return "";
  let out =
    "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const { path, content } of files) {
    out += `<file path="${path}">\n${content}\n</file>\n\n`;
  }
  out += "</project_context>";
  return out;
}

function defaultPrompt(guidelines: string[]): string {
  const g =
    guidelines.length > 0
      ? guidelines.map((x) => `- ${x}`).join("\n")
      : "(none)";
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

export function buildCpiSystemPrompt(
  options: BuildSystemPromptOptions,
  renderCtx?: Record<string, unknown>,
): string {
  const {
    customPrompt,
    promptGuidelines,
    appendSystemPrompt,
    contextFiles = [],
  } = options;

  const guidelines = (promptGuidelines ?? [])
    .map((g) => render(g, renderCtx).trim())
    .filter((g) => g.length > 0);
  guidelines.push("Be concise in your responses");
  guidelines.push("Show file paths clearly when working with files");

  // A custom --system-prompt replaces the identity/guidelines/pi-docs baseline; appended content remains.
  const base = customPrompt ? customPrompt : defaultPrompt(guidelines);

  let prompt = base;
  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;
  prompt += contextBlock(contextFiles);
  prompt += `\n\nCurrent date: ${dateStr()}`;
  prompt += `\nCurrent working directory: ${getCwd().replace(/\\/g, "/")}`;
  return prompt;
}
