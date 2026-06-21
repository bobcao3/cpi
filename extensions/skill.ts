import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";

import { registerSystemPromptTransform } from "./lib/system-prompt.ts";

const SKILL_TOOL = "skill";

interface SkillRef {
  filePath: string;
  baseDir: string;
}

let skillList: Skill[] = [];
let skills = new Map<string, SkillRef>();
let lastSkillSignature = "";

function updateSkills(list: Skill[] | undefined) {
  skillList = list ?? [];
  skills = new Map(
    skillList.map((s) => [
      s.name,
      {
        filePath: s.filePath,
        baseDir: s.baseDir,
      },
    ]),
  );
}

function visibleSkillsSignature(list: Skill[]): string {
  return list
    .filter((s) => !s.disableModelInvocation)
    .map((s) => `${s.name}\x00${s.description}`)
    .join("\x01");
}

function buildSkillToolDescription(list: Skill[] | undefined): string {
  const visible = (list ?? []).filter((s) => !s.disableModelInvocation);
  const lines = [
    "Load the full SKILL.md of a discovered skill by exact name. " +
      "Pass subdoc to load a relative sub-document inside the skill directory.",
    "",
    "Available skills:",
  ];
  if (visible.length === 0) {
    lines.push("  (none)");
  } else {
    for (const skill of visible) {
      lines.push(`- ${skill.name}: ${skill.description}`);
    }
  }
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
  // Strip pi's auto-injected "Available skills" block from the system prompt.
  // Applied by the single system-prompt owner extension; order 100 runs before
  // caveman-append (200) so the appended caveman block is never stripped.
  registerSystemPromptTransform(
    "strip-skills",
    (sp) => sp.replace(/\n\nThe following skills provide[\s\S]*?<\/available_skills>/, ""),
    100,
  );

  function registerSkillTool() {
    pi.registerTool({
      name: SKILL_TOOL,
      label: "Skill",
      description: buildSkillToolDescription(skillList),
      promptSnippet: "Load a skill by name to read its full instructions",
      promptGuidelines: [
        "Use the skill tool when a skill description matches the current task and you need the full SKILL.md instructions.",
        "Pass the exact skill name as shown in the skill tool description.",
        "To read a sub-document referenced by the skill, pass its relative path from the skill directory as subdoc.",
        "If the skill name is unknown, the result is an error listing the available skill names.",
      ],
      parameters: Type.Object({
        name: Type.String({ description: "Exact name of the skill to load" }),
        subdoc: Type.Optional(
          Type.String({
            description: "Relative path to a sub-document inside the skill directory",
          }),
        ),
      }),
      renderShell: "self",
      renderCall(args, theme, _context) {
        return new Text(skillBlurb(args.name, args.subdoc, theme), 0, 0);
      },
      renderResult(result: AgentToolResult<unknown>, _options, theme, context: any) {
        if (result.isError) {
          return undefined;
        }
        const details = result.details as { available?: string[] } | undefined;
        if (details?.available) {
          return new Text(
            theme.fg("warning", `Tried to invoke unknown skill: ${context.args.name}`),
            0,
            0,
          );
        }
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
  }

  // Keep skills + tool registration fresh, but do NOT return a mutated
  // systemPrompt: the strip-skills transform (above) owns that, applied by
  // the system-prompt owner extension.
  pi.on("before_agent_start", async (event) => {
    updateSkills(event.systemPromptOptions?.skills as Skill[] | undefined);

    const sig = visibleSkillsSignature(skillList);
    if (sig !== lastSkillSignature) {
      lastSkillSignature = sig;
      registerSkillTool();
    }
  });

  registerSkillTool();

  pi.on("session_start", async () => {
    const active = new Set(pi.getActiveTools());
    active.add(SKILL_TOOL);
    pi.setActiveTools(Array.from(active));
  });
}
