import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import {
  type Component,
  Text,
  Container,
  matchesKey,
} from "@earendil-works/pi-tui";
import {
  subagentModelEfforts,
  subagentGuidePath,
  type SubagentGuideScope,
} from "./subagent-model-guide.ts";
import { loadText, render, textPath } from "./text.ts";

const MAX_MODELS = 512;
const MAX_CATALOG_MODELS = 4096;
const BENCHMARK_SCRIPT = fileURLToPath(
  new URL(
    "../../skills/subagents-in-pi/scripts/gather-aa-benchmarks.mjs",
    import.meta.url,
  ),
);

export interface SetupText {
  command: {
    description: string;
    requires_tui: string;
    no_models: string;
    no_providers: string;
    too_many_models: string;
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
  skill: {
    guide: string;
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

export function loadSetupText(): SetupText {
  return loadText<SetupText>("subagent-models", textPath("subagent-models"));
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
): Promise<Set<string> | undefined> {
  const enabled = new Set(providers.map((provider) => provider.id));
  let index = 0;
  return ctx.ui.custom<Set<string> | undefined>((tui, theme, _keys, done) => {
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
    const rows = providers.map(() => new Text("", 1, 0));
    for (const row of rows) container.addChild(row);
    const refresh = () => {
      providers.forEach((provider, position) => {
        const cursor = position === index ? "❯" : " ";
        const box = enabled.has(provider.id) ? "[x]" : "[ ]";
        const label = `${cursor} ${box} ${provider.name} `;
        const detail = theme.fg(
          "dim",
          `${provider.id} · ${provider.models.length} models`,
        );
        rows[position]!.setText(
          position === index
            ? `${theme.fg("accent", label)}${detail}`
            : `${label}${detail}`,
        );
      });
    };
    refresh();
    const component: Component = {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "\x1b[A") {
          index = (index - 1 + providers.length) % providers.length;
        } else if (data === "\x1b[B") {
          index = (index + 1) % providers.length;
        } else if (data === " " || data === "\t" || data === "\x1b[Z") {
          const id = providers[index]!.id;
          if (enabled.has(id)) enabled.delete(id);
          else enabled.add(id);
        } else if (data === "\r" || data === "\n") {
          done(new Set(enabled));
          return;
        } else if (matchesKey(data, "escape")) {
          done(undefined);
          return;
        } else {
          return;
        }
        refresh();
        tui.requestRender();
      },
    };
    return component;
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

export async function prepareWorkflow(
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
  if (!selected) return undefined;
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

/** Confirm, collect the selection, and send the setup workflow straight into context. */
export async function runSubagentGuideSetup(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Promise<void> {
  if (ctx.mode !== "tui") return;
  const text = loadSetupText();
  const start = await ctx.ui.confirm(
    text.command.confirm_title,
    text.command.confirm_message,
  );
  if (!start) return;
  const prompt = await prepareWorkflow(ctx, text);
  if (prompt) pi.sendUserMessage(prompt);
}
