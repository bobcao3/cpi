/**
 * Editor subagent model resolution: explicit `editor.model`, else the
 * `editor.chain` search/replace rules — regex over "<provider>/<model-id>:<thinkingLevel>",
 * `$1`..`$9` backrefs, EXACT id match, first authed wins — else identity.
 * Cached in globalThis keyed by cwd + main model (survives jiti reloads).
 */

import type {
  ExtensionContext,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { loadEditorConfig } from "../lib/config.ts";
import { loadEditorText, fmt } from "./text.ts";

export interface EditorPick {
  provider: string;
  modelId: string;
  thinkingLevel?: string;
}

interface Cache {
  cwd: string;
  mainKey: string;
  thinkingLevel: string;
  pick: EditorPick;
}

const GLOBAL_KEY = "__cpiEditorModel";

function state(): { pick: Cache | null } {
  const g = globalThis as Record<string, unknown>;
  const s = g[GLOBAL_KEY] as { pick: Cache | null } | undefined;
  if (s && typeof s === "object") return s;
  const fresh = { pick: null as Cache | null };
  g[GLOBAL_KEY] = fresh;
  return fresh;
}

let _thinkingApi: ExtensionAPI | undefined;

export function setThinkingApi(pi: ExtensionAPI): void {
  _thinkingApi = pi;
}

export function getThinkingApi(): ExtensionAPI | undefined {
  return _thinkingApi;
}

function inferProvider(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  if (
    id.includes("claude") ||
    id.includes("sonnet") ||
    id.includes("opus") ||
    id.includes("haiku")
  )
    return "anthropic";
  if (id.includes("gpt")) return "openai";
  if (id.includes("gemini")) return "google";
  if (id.includes("grok")) return "xai";
  if (id.includes("deepseek")) return "deepseek";
  return undefined;
}

/** Exact id lookup: prefer `preferProvider`, else first authed match across all providers. */
function resolveExact(
  ctx: ExtensionContext,
  modelId: string,
  preferProvider?: string,
): Model<Api> | undefined {
  if (!modelId) return undefined;
  if (preferProvider) {
    const m = ctx.modelRegistry.find(preferProvider, modelId);
    if (m && ctx.modelRegistry.hasConfiguredAuth(m)) return m;
  }
  for (const m of ctx.modelRegistry.getAvailable()) {
    if (m.id === modelId) return m;
  }
  return undefined;
}

function compileRule(
  T: ReturnType<typeof loadEditorText>,
  rule: { search: string },
  i: number,
): RegExp | null {
  try {
    return new RegExp(rule.search);
  } catch {
    const tpl = T.errors.invalid_chain_regex;
    const msg = tpl
      ? fmt(tpl, { pattern: rule.search, i: i + 1 })
      : `[editor] chain rule ${i + 1}: invalid regex ${rule.search}`;
    process.stderr.write(msg + "\n");
    return null;
  }
}

export function resolveEditorModel(ctx: ExtensionContext): EditorPick {
  const main = ctx.model;
  const mainThinkingLevel = main
    ? (getThinkingApi()?.getThinkingLevel() ?? "off")
    : "off";
  const mainKey = main ? `${main.provider}/${main.id}` : "";
  const cached = state().pick;
  if (
    cached &&
    cached.cwd === ctx.cwd &&
    cached.mainKey === mainKey &&
    cached.thinkingLevel === mainThinkingLevel
  )
    return cached.pick;

  const cfg = loadEditorConfig(ctx.cwd);
  const T = loadEditorText(ctx.cwd);
  let pick: EditorPick | undefined;

  if (cfg.model) {
    const m = resolveExact(
      ctx,
      cfg.model,
      cfg.provider ?? inferProvider(cfg.model),
    );
    if (m) pick = { provider: m.provider, modelId: m.id };
    else
      process.stderr.write(
        fmt(T.errors.configured_unavailable, { model: cfg.model }) + "\n",
      );
  }

  if (!pick && main) {
    const combinedInput = `${main.provider}/${main.id}:${mainThinkingLevel}`;
    for (let i = 0; i < cfg.chain.length; i++) {
      const rule = cfg.chain[i];
      const re = compileRule(T, rule, i);
      if (!re || !re.test(combinedInput)) continue;
      const combinedOutput = combinedInput.replace(re, rule.replace);
      const lastColon = combinedOutput.lastIndexOf(":");
      const modelPart =
        lastColon === -1 ? combinedOutput : combinedOutput.slice(0, lastColon);
      const effortPart =
        lastColon === -1 ? undefined : combinedOutput.slice(lastColon + 1);
      let m: Model<Api> | undefined;
      if (modelPart.includes("/")) {
        const slashIdx = modelPart.indexOf("/");
        const provider = modelPart.slice(0, slashIdx);
        const modelId = modelPart.slice(slashIdx + 1);
        m = resolveExact(ctx, modelId, provider);
      } else {
        m = resolveExact(ctx, modelPart, main.provider);
      }
      if (m) {
        pick = {
          provider: m.provider,
          modelId: m.id,
          thinkingLevel: effortPart || undefined,
        };
        break;
      }
    }
    if (!pick) {
      pick = {
        provider: main.provider,
        modelId: main.id,
        thinkingLevel:
          mainThinkingLevel !== "off" ? mainThinkingLevel : undefined,
      };
    }

    // Safety clamp: "off" is never safe when the main model has thinking enabled.
    if (
      mainThinkingLevel !== "off" &&
      (!pick.thinkingLevel || pick.thinkingLevel === "off")
    ) {
      pick.thinkingLevel = "minimal";
    }
  }

  if (!pick) throw new Error(T.errors.no_editor_model);
  state().pick = {
    cwd: ctx.cwd,
    mainKey,
    thinkingLevel: mainThinkingLevel,
    pick,
  };
  return pick;
}
