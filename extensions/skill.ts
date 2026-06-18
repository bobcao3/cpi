import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

const SKILL_TOOL = "skill";

interface SkillRef {
  filePath: string;
  baseDir: string;
}

let skills = new Map<string, SkillRef>();

function updateSkills(list: Skill[] | undefined) {
  if (!list) return;
  skills = new Map(
    list.map((s) => [
      s.name,
      {
        filePath: s.filePath,
        baseDir: s.baseDir,
      },
    ]),
  );
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildSkillsPrompt(list: Skill[] | undefined): string {
  const visible = (list ?? []).filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the skill tool to load a skill by name when the task matches its description. " +
      "To load a sub-document, pass its relative path from the skill directory as subdoc.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function resolveSubdoc(baseDir: string, subdoc: string): string {
  const resolved = resolve(baseDir, subdoc);
  const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (resolved !== baseDir && !resolved.startsWith(prefix)) {
    throw new Error(`subdoc escapes skill directory: ${subdoc}`);
  }
  return resolved;
}

function skillBlurb(name: string, subdoc: string | undefined, theme: any): string {
  let text = theme.fg("toolTitle", "Using skill: ");
  text += theme.fg("accent", name);
  if (subdoc) {
    text += theme.fg("dim", ` / ${subdoc}`);
  }
  return text;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    updateSkills(event.systemPromptOptions?.skills as Skill[] | undefined);

    let systemPrompt = event.systemPrompt;
    systemPrompt = systemPrompt.replace(
      /\n\nThe following skills provide[\s\S]*?<\/available_skills>/,
      "",
    );
    systemPrompt += buildSkillsPrompt(event.systemPromptOptions?.skills as Skill[] | undefined);

    return { systemPrompt };
  });

  pi.registerTool({
    name: SKILL_TOOL,
    label: "Skill",
    description:
      "Load the full SKILL.md of a discovered skill by exact name. Pass subdoc to load a relative sub-document inside the skill directory.",
    promptSnippet: "Load a skill by name to read its full instructions",
    promptGuidelines: [
      "Use the skill tool when a skill description matches the current task and you need the full SKILL.md instructions.",
      "Pass the exact skill name as shown in the available skills list.",
      "To read a sub-document referenced by the skill, pass its relative path from the skill directory as subdoc.",
      "If the skill name is unknown, the tool returns the list of available skill names.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Exact name of the skill to load" }),
      subdoc: Type.Optional(
        Type.String({ description: "Relative path to a sub-document inside the skill directory" }),
      ),
    }),
    renderShell: "self",
    renderCall(args, theme, _context) {
      return new Text(skillBlurb(args.name, args.subdoc, theme), 0, 0);
    },
    renderResult(result: AgentToolResult<unknown>, _options, theme, _context) {
      if (result.isError) {
        return undefined;
      }
      // Zero-width space keeps the result slot non-empty in HTML export so the
      // full skill text is not rendered, while remaining invisible in the TUI.
      return new Text(theme.fg("dim", "\u200b"), 0, 0);
    },
    async execute(_toolCallId, params) {
      const ref = skills.get(params.name);
      if (!ref) {
        const names = Array.from(skills.keys()).sort();
        return {
          content: [
            {
              type: "text",
              text: `Unknown skill: ${params.name}. Available: ${names.join(", ") || "none"}`,
            },
          ],
          details: { available: names },
        };
      }

      let target: string;
      if (params.subdoc?.trim()) {
        target = resolveSubdoc(ref.baseDir, params.subdoc.trim());
      } else {
        target = ref.filePath;
      }

      const text = readFileSync(target, "utf8");
      return {
        content: [{ type: "text", text }],
        details: { name: params.name, subdoc: params.subdoc, path: target },
      };
    },
  });

  pi.on("session_start", async () => {
    const active = new Set(pi.getActiveTools());
    active.add(SKILL_TOOL);
    pi.setActiveTools(Array.from(active));
  });
}
