import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { loadText, render, renderLines, textPath, type ToolText } from "./lib/text.ts";

import { registerSystemPromptTransform } from "./lib/system-prompt.ts";

const SKILL_TOOL = "skill";
const SKILL_TEXT = loadText<ToolText>("skill", textPath("skill"));

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
  const skills = visible.map((s) => ({ name: s.name, description: s.description }));
  return render(SKILL_TEXT.tool.description, { skills }).trimEnd();
}

function resolveSubdoc(baseDir: string, subdoc: string): string {
  const resolved = resolve(baseDir, subdoc);
  const prefix = baseDir.endsWith(sep) ? baseDir : `${baseDir}${sep}`;
  if (resolved !== baseDir && !resolved.startsWith(prefix)) {
    throw new Error(`subdoc escapes skill directory: ${subdoc}`);
  }
  return resolved;
}

function listSubdocs(baseDir: string, excludeAbs: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(baseDir, { recursive: true }) as string[];
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rel of entries) {
    const abs = resolve(baseDir, rel);
    if (abs === excludeAbs) continue;
    try {
      if (statSync(abs).isFile()) out.push(rel);
    } catch {
      /* skip non-statable entries */
    }
  }
  return out.sort();
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
      promptSnippet: SKILL_TEXT.tool.prompt_snippet,
      promptGuidelines: renderLines(SKILL_TEXT.guidelines.bullets, {}),
      parameters: Type.Object({
        name: Type.String({ description: SKILL_TEXT.schema!.name }),
        subdoc: Type.Optional(
          Type.String({ description: SKILL_TEXT.schema!.subdoc }),
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
        const details = result.details as { available?: string[]; kind?: "skill" | "subdoc" } | undefined;
        if (details?.available) {
          const what =
            details.kind === "subdoc"
              ? `subdoc ${context.args.name}/${context.args.subdoc}`
              : `skill ${context.args.name}`;
          return new Text(theme.fg("warning", `Tried to invoke unknown ${what}`), 0, 0);
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
          if (!existsSync(target) || !statSync(target).isFile()) {
            const subs = listSubdocs(ref.baseDir, ref.filePath);
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown subdoc: ${params.subdoc} in skill ${params.name}. Available subdocs: ${subs.join(", ") || "none"}`,
                },
              ],
              details: { available: subs, kind: "subdoc" },
            };
          }
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
