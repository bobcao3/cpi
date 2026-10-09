import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  findSubagentModelGuide,
  injectSubagentGuide,
  SUBAGENT_SKILL_NAME,
} from "./lib/subagent-model-guide.ts";
import { loadSetupText, prepareWorkflow } from "./lib/subagent-setup.ts";
import { render } from "./lib/text.ts";

export default function subagentModelsExtension(pi: ExtensionAPI): void {
  const text = loadSetupText();
  let skillPath: string | undefined;

  pi.on("before_agent_start", (event) => {
    skillPath = event.systemPromptOptions.skills?.find(
      (skill) => skill.name === SUBAGENT_SKILL_NAME,
    )?.filePath;
  });

  pi.on("context", (event, ctx) => {
    if (!skillPath) return;
    const guide = findSubagentModelGuide(ctx.cwd, ctx.isProjectTrusted());
    if (!guide) return;
    const block = render(text.skill.guide, {
      path: guide.path,
      guide: guide.text,
    }).trim();
    const messages = injectSubagentGuide(
      event.messages,
      SUBAGENT_SKILL_NAME,
      skillPath,
      block,
    );
    return messages ? { messages } : undefined;
  });

  pi.registerCommand("setup-subagent-models", {
    description: text.command.description,
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(text.command.requires_tui, "error");
        return;
      }
      await ctx.waitForIdle();
      const prompt = await prepareWorkflow(ctx, text);
      if (prompt) pi.sendUserMessage(prompt);
    },
  });
}
