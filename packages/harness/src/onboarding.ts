import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { findSubagentModelGuide } from "./lib/subagent-model-guide.ts";
import { runSubagentGuideSetup } from "./lib/subagent-setup.ts";
import { loadText, textPath } from "./lib/text.ts";

interface OnboardingText {
  setup: {
    model: string;
    effort: string;
  };
}

interface OnboardingApi {
  runCommand?: (text: string) => Promise<boolean>;
  setDefaultModel?: (provider: string, modelId: string) => void;
  setDefaultThinkingLevel?: (level: string) => void;
  getThinkingLevel?: () => string;
}

const DEFAULT_MODEL_WIDGET = "onboarding-default-model";

function hasConfiguredAuth(ctx: ExtensionContext): boolean {
  const providers = new Set(
    ctx.modelRegistry.getAll().map((model) => model.provider),
  );
  for (const provider of providers) {
    if (ctx.modelRegistry.getProviderAuthStatus(provider).configured) {
      return true;
    }
  }
  return false;
}

function hasDefaultModel(pi: ExtensionAPI): boolean {
  const settings = pi.getSettings();
  return Boolean(settings.defaultProvider && settings.defaultModel);
}

function hasHistory(ctx: ExtensionContext): boolean {
  return ctx.sessionManager.getEntries().some((entry) => {
    if (entry.type !== "message") return false;
    return (
      (entry as { message?: { role?: string } }).message?.role !== "system"
    );
  });
}

export default function onboardingExtension(pi: ExtensionAPI): void {
  const text = loadText<OnboardingText>("onboarding", textPath("onboarding"));
  let busy = false;
  let authStep = false;
  let modelStep = false;
  let guideStep = false;
  let active = false;

  async function advance(ctx: ExtensionContext): Promise<void> {
    if (busy || ctx.mode !== "tui" || process.env.PI_SUBAGENT) return;
    const api = pi as unknown as OnboardingApi;
    busy = true;
    try {
      if (!authStep) {
        authStep = true;
        if (!hasConfiguredAuth(ctx)) {
          if (api.runCommand) await api.runCommand("/login");
          return;
        }
      }
      if (!modelStep) {
        modelStep = true;
        if (!hasDefaultModel(pi)) {
          if (api.runCommand) {
            try {
              ctx.ui.setWidget(DEFAULT_MODEL_WIDGET, [text.setup.model]);
              await api.runCommand("/model");
              if (ctx.model && api.setDefaultModel) {
                api.setDefaultModel(ctx.model.provider, ctx.model.id);
              }
              ctx.ui.setWidget(DEFAULT_MODEL_WIDGET, [text.setup.effort]);
              await api.runCommand("/thinking");
              if (api.setDefaultThinkingLevel && api.getThinkingLevel) {
                api.setDefaultThinkingLevel(api.getThinkingLevel());
              }
            } finally {
              ctx.ui.setWidget(DEFAULT_MODEL_WIDGET, undefined);
            }
          }
          return;
        }
      }
      if (!guideStep) {
        guideStep = true;
        if (!findSubagentModelGuide(ctx.cwd, ctx.isProjectTrusted())) {
          await runSubagentGuideSetup(pi, ctx);
        }
      }
    } finally {
      busy = false;
    }
  }

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup" || hasHistory(ctx)) return;
    active = true;
    await advance(ctx);
  });
  pi.on("agent_end", async (_event, ctx) => {
    if (!active) return;
    await advance(ctx);
  });
}
