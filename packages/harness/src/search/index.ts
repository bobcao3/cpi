import type {
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadText, render, textPath } from "../lib/text.ts";
import { search_config } from "./config.ts";
import { provider_chain } from "./chain.ts";
import { public_url } from "./http.ts";
import { route } from "./route.ts";
import { PROVIDER_NAMES, type FetchInput, type SearchInput } from "./types.ts";

interface SearchText {
  search_query: { description: string };
  web_fetch: { description: string };
  schema: Record<string, string>;
}

export default function search_extension(pi: ExtensionAPI): void {
  const text = loadText<SearchText>("search", textPath("search"));
  const outputSchema = Type.Object({
    provider: Type.Union(PROVIDER_NAMES.map((name) => Type.Literal(name))),
    text: Type.String(),
    sources: Type.Array(
      Type.Object({ url: Type.String(), title: Type.Optional(Type.String()) }),
    ),
    truncated: Type.Boolean(),
    attempts: Type.Array(
      Type.Object({ provider: Type.String(), error: Type.String() }),
    ),
  });
  async function run(
    operation: "search" | "fetch",
    input: SearchInput | FetchInput,
    signal: AbortSignal | undefined,
    ctx: ExtensionToolContext,
  ) {
    if (operation === "fetch") public_url((input as FetchInput).url);
    const config = search_config(ctx.cwd, ctx.isProjectTrusted());
    const maxCharacters =
      (input as FetchInput).maxCharacters ?? config.maxCharacters;
    const result = await route(
      provider_chain(config, ctx),
      (provider, attempt_signal) =>
        operation === "search"
          ? provider.search(input as SearchInput, attempt_signal)
          : provider.fetch(
              { ...(input as FetchInput), maxCharacters },
              attempt_signal,
            ),
      config.timeoutMs,
      maxCharacters,
      signal,
    );
    const { usage, ...payload } = result;
    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload) }],
      details: undefined,
      structuredContent: payload,
      ...(usage ? { usage } : {}),
    };
  }
  const common = {
    exposure: "codemode" as const,
    outputSchema,
    annotations: { readOnlyHint: true, openWorldHint: true },
    prepareLoadout: () => ({
      hiddenDeclarations: ["search_query", "web_fetch"],
    }),
  };
  pi.registerTool({
    ...common,
    name: "search_query",
    label: "Search",
    description: render(text.search_query.description, {}),
    parameters: Type.Object({
      query: Type.String({
        minLength: 2,
        maxLength: 4000,
        pattern: "\\S",
        description: text.schema.query,
      }),
      numResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 20,
          description: text.schema.numResults,
        }),
      ),
    }),
    execute: (_id, input, signal, _update, ctx) =>
      run("search", input, signal, ctx),
  });
  pi.registerTool({
    ...common,
    name: "web_fetch",
    label: "Fetch web page",
    description: render(text.web_fetch.description, {}),
    parameters: Type.Object({
      url: Type.String({
        minLength: 1,
        maxLength: 8000,
        description: text.schema.url,
      }),
      maxCharacters: Type.Optional(
        Type.Integer({
          minimum: 500,
          maximum: 50000,
          description: text.schema.maxCharacters,
        }),
      ),
    }),
    execute: (_id, input, signal, _update, ctx) =>
      run("fetch", input, signal, ctx),
  });
}
