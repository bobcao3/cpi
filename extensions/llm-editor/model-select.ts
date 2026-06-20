/**
 * Editor subagent model resolution via a raw-regex search(capture)/replace chain.
 *
 *   1. `editor.model` (explicit) -> use if available (exact).
 *   2. `editor.chain`: ordered `{ search, replace }` rules. `search` is a plain
 *      JavaScript RegExp source applied to the main model id; `replace` is the
 *      replacement string (supports `$1`..`$9` backrefs, `$&` whole match). For
 *      each rule whose `search` tests against the main model id, the candidate is
 *      `mainId.replace(search, replace)` (the matched span is rewritten) and is
 *      resolved EXACTLY across all providers; the first available+authed wins.
 *      Miss -> next rule. Captures reuse parts of the main id (`$1`), so a rule
 *      targets a whole family version-aligned rather than a pinned id; multiple
 *      rules per family cover provider/env variants (gpt-5-mini under openai,
 *      gpt-5.4-mini under openai-codex) -- fall-through picks whichever exists.
 *   3. Implicit identity: keep the main model (guaranteed fallback).
 *
 * Raw regex syntax: bare `(...)` capture, `|` alternation, `.` `*` `+` `?` `^`
 * `$` `[..]` `\d` `\w` `\s` are standard JS. No escaping beyond JSON's own; write
 * `(gpt-5).*` not `\(gpt-5\).*`. `$1` in `replace`, not `\1`.
 * Shipped defaults target the latest/best model at ≤0.6x of the main model's
 * cost (primary ~0.2x, fallback up to 0.6x) that is also ≤6 months old, per
 * family, relying on rule fall-through for the availability ladder. Stale
 * (>6mo) or retired models (e.g. grok-code-fast-1, gpt-4o-mini,
 * gemini-2.5-flash, claude-haiku-4-5) are never targets; identity keeps the
 * main when no fresh cheaper model exists.
 *
 * Resolution is EXACT (candidate must equal a registered model id). The only
 * transformation is `mainId.replace`, so what a rule does is fully visible.
 *
 * Resolved pick cached in globalThis (shared across jiti reloads), keyed by
 * cwd + main-model id. Pure leaf: pi-ai + lib/config + text.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { loadEditorConfig } from "../lib/config.ts";
import { loadEditorText, fmt } from "./text.ts";

export interface EditorPick {
  provider: string;
  modelId: string;
}

interface Cache {
  cwd: string;
  mainKey: string;
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

/** Infer a provider from a model id when `editor.provider` is absent. */
function inferProvider(modelId: string): string | undefined {
  const id = modelId.toLowerCase();
  if (id.includes("claude") || id.includes("sonnet") || id.includes("opus") || id.includes("haiku"))
    return "anthropic";
  if (id.includes("gpt")) return "openai";
  if (id.includes("gemini")) return "google";
  if (id.includes("grok")) return "xai";
  if (id.includes("deepseek")) return "deepseek";
  return undefined;
}

/** Exact model-id lookup: prefer `preferProvider`, else first authed match across all. */
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
      : `[llm-editor] chain rule ${i + 1}: invalid regex ${rule.search}`;
    process.stderr.write(msg + "\n");
    return null;
  }
}

export function resolveEditorModel(ctx: ExtensionContext): EditorPick {
  const main = ctx.model;
  const mainKey = main ? `${main.provider}/${main.id}` : "";
  const cached = state().pick;
  if (cached && cached.cwd === ctx.cwd && cached.mainKey === mainKey) return cached.pick;

  const cfg = loadEditorConfig(ctx.cwd);
  const T = loadEditorText(ctx.cwd);
  let pick: EditorPick | undefined;

  // 1. Explicit configured model.
  if (cfg.model) {
    const m = resolveExact(ctx, cfg.model, cfg.provider ?? inferProvider(cfg.model));
    if (m) pick = { provider: m.provider, modelId: m.id };
    else process.stderr.write(fmt(T.errors.configured_unavailable, { model: cfg.model }) + "\n");
  }

  // 2. regex->model chain over the main model id.
  if (!pick && main) {
    for (let i = 0; i < cfg.chain.length; i++) {
      const rule = cfg.chain[i];
      const re = compileRule(T, rule, i);
      if (!re || !re.test(main.id)) continue;
      const candidateId = main.id.replace(re, rule.replace);
      const m = resolveExact(ctx, candidateId);
      if (m) {
        pick = { provider: m.provider, modelId: m.id };
        break;
      }
    }
    // 3. Implicit identity: keep the main model.
    if (!pick) pick = { provider: main.provider, modelId: main.id };
  }

  if (!pick) throw new Error(T.errors.no_editor_model);
  state().pick = { cwd: ctx.cwd, mainKey, pick };
  return pick;
}
