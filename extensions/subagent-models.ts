import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Text,
} from "@earendil-works/pi-tui";
import {
  findSubagentModelGuide,
  subagentModelEfforts,
  subagentGuidePath,
  type SubagentGuideScope,
} from "./lib/subagent-model-guide.ts";
import { loadText, render, textPath } from "./lib/text.ts";

const MAX_MODELS = 512;
const MAX_CATALOG_MODELS = 4096;
const BENCHMARK_SCRIPT = fileURLToPath(
  new URL(
    "../skills/subagents-in-pi/scripts/gather-aa-benchmarks.mjs",
    import.meta.url,
  ),
);
interface SetupText {
  command: {
    description: string;
    requires_tui: string;
    no_models: string;
    no_providers: string;
    too_many_models: string;
    ready: string;
    confirm_title: string;
    confirm_message: string;
    provider_title: string;
    provider_hint: string;
    scope_title: string;
    scope_user: string;
    scope_project: string;
  };
  workflow: {
    prompt: string;
    guide_template: string;
  };
}

interface ModelChoice {
  provider: string;
  id: string;
  efforts: string[];
}

interface ProviderChoice {
  id: string;
  name: string;
  models: ModelChoice[];
}

function modelChoices(ctx: ExtensionContext): ModelChoice[] | undefined {
  const scoped = ctx.scopedModels.length > 0;
  const source: Array<{ model: unknown; thinkingLevel?: string }> = scoped
    ? ctx.scopedModels.map((item) => ({
        model: item.model,
        thinkingLevel: item.thinkingLevel,
      }))
    : ctx.modelRegistry.getAvailable().map((model) => ({ model }));
  if (source.length > MAX_CATALOG_MODELS) return undefined;
  const choices = new Map<string, ModelChoice>();
  for (const item of source) {
    const model = item.model as unknown as Record<string, unknown>;
    if (typeof model.provider !== "string" || typeof model.id !== "string") {
      continue;
    }
    const choice = {
      provider: model.provider,
      id: model.id,
      efforts: subagentModelEfforts(
        model.reasoning === true,
        model.thinkingLevelMap,
        item.thinkingLevel,
      ),
    };
    choices.set(`${choice.provider}\0${choice.id}`, choice);
  }
  return [...choices.values()].sort((a, b) =>
    `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
  );
}

function providerChoices(
  ctx: ExtensionContext,
  models: ModelChoice[],
): ProviderChoice[] {
  const grouped = new Map<string, ModelChoice[]>();
  for (const model of models) {
    const entries = grouped.get(model.provider) ?? [];
    entries.push(model);
    grouped.set(model.provider, entries);
  }
  return [...grouped]
    .map(([id, entries]) => ({
      id,
      name: ctx.modelRegistry.getProviderDisplayName(id),
      models: entries,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function pickProviders(
  ctx: ExtensionContext,
  text: SetupText,
  providers: ProviderChoice[],
): Promise<Set<string>> {
  const enabled = new Set(providers.map((provider) => provider.id));
  return ctx.ui.custom<Set<string>>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(
      new Text(
        theme.fg("accent", theme.bold(text.command.provider_title)),
        1,
        0,
      ),
    );
    container.addChild(
      new Text(theme.fg("dim", text.command.provider_hint), 1, 0),
    );
    const items: SettingItem[] = providers.map((provider) => ({
      id: provider.id,
      label: provider.name,
      description: `${provider.id} · ${provider.models.length} models`,
      currentValue: "enabled",
      values: ["enabled", "disabled"],
    }));
    const list = new SettingsList(
      items,
      Math.min(items.length + 2, 15),
      getSettingsListTheme(),
      (id, value) => {
        if (value === "enabled") enabled.add(id);
        else enabled.delete(id);
        tui.requestRender();
      },
      () => done(new Set(enabled)),
      { enableSearch: true },
    );
    container.addChild(list);
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

async function pickScope(
  ctx: ExtensionContext,
  text: SetupText,
): Promise<SubagentGuideScope | undefined> {
  const options = [text.command.scope_user];
  if (ctx.isProjectTrusted()) options.push(text.command.scope_project);
  const choice = await ctx.ui.select(text.command.scope_title, options);
  if (choice === text.command.scope_project) return "project";
  return choice === text.command.scope_user ? "user" : undefined;
}

function modelInventory(models: ModelChoice[]): string {
  return models
    .flatMap((model) =>
      model.efforts.length > 0
        ? model.efforts.map(
            (effort) => `- \`${model.provider}/${model.id}:${effort}\``,
          )
        : [`- \`${model.provider}/${model.id}\``],
    )
    .join("\n");
}

async function prepareWorkflow(
  ctx: ExtensionContext,
  text: SetupText,
): Promise<string | undefined> {
  const models = modelChoices(ctx);
  if (!models) {
    ctx.ui.notify(text.command.too_many_models, "error");
    return undefined;
  }
  const providers = providerChoices(ctx, models);
  if (models.length === 0 || providers.length === 0) {
    ctx.ui.notify(text.command.no_models, "warning");
    return undefined;
  }
  const selected = await pickProviders(ctx, text, providers);
  if (selected.size === 0) {
    ctx.ui.notify(text.command.no_providers, "warning");
    return undefined;
  }
  const selectedModels = models.filter((model) => selected.has(model.provider));
  if (selectedModels.length > MAX_MODELS) {
    ctx.ui.notify(text.command.too_many_models, "error");
    return undefined;
  }
  const scope = await pickScope(ctx, text);
  if (!scope) return undefined;
  const selectedProviders = providers
    .filter((provider) => selected.has(provider.id))
    .map((provider) => ({ id: provider.id, name: provider.name }));
  return render(text.workflow.prompt, {
    targetPath: subagentGuidePath(ctx.cwd, scope),
    providers: selectedProviders,
    models: modelInventory(selectedModels),
    benchmarkScript: BENCHMARK_SCRIPT,
    guideTemplate: text.workflow.guide_template,
  }).trim();
}

export default function subagentModelsExtension(pi: ExtensionAPI): void {
  const text = loadText<SetupText>(
    "subagent-models",
    textPath("subagent-models"),
  );

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

  pi.on("session_start", async (event, ctx) => {
    if (
      event.reason !== "startup" ||
      ctx.mode !== "tui" ||
      findSubagentModelGuide(ctx.cwd, ctx.isProjectTrusted())
    ) {
      return;
    }
    const start = await ctx.ui.confirm(
      text.command.confirm_title,
      text.command.confirm_message,
    );
    if (!start) return;
    const prompt = await prepareWorkflow(ctx, text);
    if (!prompt) return;
    ctx.ui.setEditorText(prompt);
    ctx.ui.notify(text.command.ready, "info");
  });
}
