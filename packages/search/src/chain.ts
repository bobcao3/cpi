import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { codex_provider } from "./codex.ts";
import { deepseek_provider } from "./deepseek.ts";
import { exa_provider } from "./exa.ts";
import { searxng_provider } from "./searxng.ts";
import type { SearchConfig } from "./config.ts";
import type { ProviderFactory } from "./route.ts";

export function provider_chain(
  config: SearchConfig,
  ctx: ExtensionContext,
): ProviderFactory[] {
  return config.providers.map((name) => ({
    name,
    async create(signal) {
      signal.throwIfAborted();
      switch (name) {
        case "codex":
          return codex_provider(ctx, config.codexModel ?? undefined);
        case "exa":
          return exa_provider(process.env.EXA_API_KEY);
        case "searxng":
          return config.searxngUrl
            ? searxng_provider(config.searxngUrl)
            : undefined;
        case "deepseek": {
          const key =
            (await ctx.modelRegistry.getApiKeyForProvider("deepseek")) ||
            process.env.DEEPSEEK_API_KEY;
          signal.throwIfAborted();
          return key ? deepseek_provider(key) : undefined;
        }
      }
    },
  }));
}
