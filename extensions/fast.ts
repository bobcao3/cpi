import {
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  installFastModels,
  isGeneratedFastModel,
  canonicalFastModel,
} from "../bin/fast-models.mjs";
import { getCwd } from "./lib/cwd.ts";
import { clearRightSegment } from "./lib/footer.ts";
import { loadFastConfig } from "./lib/fast-config.ts";
import { loadText, render, textPath, type ToolText } from "./lib/text.ts";
type FastText = ToolText & {
  flag: { description: string };
  messages: { usage: string; unavailable: string; auth: string };
};
function cliModel(): string | undefined {
  const args = process.argv;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--model" || args[index] === "-m")
      return args[index + 1];
    if (args[index].startsWith("--model=")) return args[index].slice(8);
  }
  return undefined;
}
export default function fastExtension(pi: ExtensionAPI): void {
  const text = loadText<FastText>("fast", textPath("fast"));
  const actions = new Map([
    ["on", true],
    ["off", false],
  ]);
  const options = [...actions.keys()];
  clearRightSegment("fast");
  installFastModels(ModelRuntime, () => loadFastConfig(getCwd()));
  const select = async (
    enabled: boolean,
    ctx: ExtensionContext,
    required = false,
  ): Promise<void> => {
    const current = ctx.model;
    const id = current?.id;
    if (!current || !id)
      throw new Error(render(text.messages.unavailable, { model: "" }));
    const targetId = enabled
      ? id.endsWith("-fast")
        ? id
        : `${id}-fast`
      : id.endsWith("-fast")
        ? id.slice(0, -5)
        : id;
    const target = ctx.modelRegistry.find(current.provider, targetId);
    if (!target) {
      if (required && enabled) {
        const effort = pi.getThinkingLevel();
        await pi.setModel({ ...current, id: targetId });
        pi.setThinkingLevel(effort);
      }
      throw new Error(
        render(text.messages.unavailable, {
          model: `${current.provider}/${targetId}`,
        }),
      );
    }
    if (targetId === id) return;
    const effort = pi.getThinkingLevel();
    if (!(await pi.setModel(target)))
      throw new Error(
        render(text.messages.auth, {
          model: `${target.provider}/${target.id}`,
        }),
      );
    pi.setThinkingLevel(effort);
  };
  const migrate = async (ctx: ExtensionContext): Promise<void> => {
    if (cliModel()) return;
    let legacy: boolean | undefined;
    let selected: { provider: string; modelId: string } | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "model_change") {
        legacy = undefined;
        selected = entry;
      }
      if (entry.type === "custom" && entry.customType === "fast-state") {
        const data = entry.data as { enabled?: unknown } | undefined;
        if (typeof data?.enabled === "boolean") legacy = data.enabled;
      }
    }
    if (
      legacy === undefined ||
      !selected ||
      selected.provider !== ctx.model?.provider ||
      selected.modelId !== ctx.model?.id
    )
      return;
    await select(legacy, ctx, true);
  };
  pi.registerFlag("fast", {
    description: render(text.flag.description, {}),
    type: "boolean",
    default: false,
  });
  pi.registerCommand("fast", {
    description: render(text.tool.description, {}),
    getArgumentCompletions(prefix) {
      const matches = options.filter((option) =>
        option.startsWith(prefix.trim().toLowerCase()),
      );
      return matches.length
        ? matches.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      try {
        const value = args.trim().toLowerCase();
        const enabled = actions.get(value);
        if (value && enabled === undefined)
          throw new Error(
            render(text.messages.usage, { options: options.join("|") }),
          );
        await select(enabled ?? !ctx.model?.id.endsWith("-fast"), ctx);
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    const explicit = cliModel()
      ?.toLowerCase()
      .replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
    if (
      explicit &&
      isGeneratedFastModel(ctx.model) &&
      explicit !== ctx.model?.id.toLowerCase() &&
      explicit !== `${ctx.model?.provider}/${ctx.model?.id}`.toLowerCase()
    ) {
      const base = ctx.modelRegistry.find(
        ctx.model!.provider,
        canonicalFastModel(ctx.model),
      );
      if (base) {
        const effort = pi.getThinkingLevel();
        await pi.setModel(base);
        pi.setThinkingLevel(effort);
      }
    }
    const saved = ctx.sessionManager
      .getBranch()
      .filter((entry) => entry.type === "model_change")
      .at(-1);
    if (
      !explicit &&
      !process.env.PI_SUBAGENT &&
      saved?.modelId.endsWith("-fast") &&
      !ctx.modelRegistry.find(saved.provider, saved.modelId) &&
      ctx.model
    ) {
      const effort = pi.getThinkingLevel();
      await pi.setModel({
        ...ctx.model,
        provider: saved.provider,
        id: saved.modelId,
      });
      pi.setThinkingLevel(effort);
      throw new Error(
        render(text.messages.unavailable, {
          model: `${saved.provider}/${saved.modelId}`,
        }),
      );
    }
    if (pi.getFlag("fast") === true) await select(true, ctx, true);
    else await migrate(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => {
    await migrate(ctx);
  });
}
