import {
  calculateCost,
  type Api,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  codex_request,
  http_url,
  list,
  record,
  responses_output,
} from "./codex-http.ts";
import type { ProviderResult, SearchProvider, Source } from "./types.ts";

const provider_names = ["openai-codex", "openai"];
const max_text_characters = 80_000;

async function auth_headers(
  ctx: ExtensionContext,
  accept: string,
): Promise<Headers | undefined> {
  for (const provider of provider_names) {
    try {
      const resolved = await ctx.modelRegistry.getProviderAuth(provider);
      const token = resolved?.auth.apiKey;
      if (!token || token.split(".").length !== 3) continue;
      const payload = record(
        JSON.parse(
          Buffer.from(token.split(".")[1] ?? "", "base64url").toString(),
        ),
      );
      const account = record(
        payload["https://api.openai.com/auth"],
      ).chatgpt_account_id;
      if (typeof account !== "string" || !account.trim()) continue;
      return new Headers({
        Authorization: `Bearer ${token}`,
        "chatgpt-account-id": account,
        "content-type": "application/json",
        accept,
        originator: "codex_cli_rs",
        "OpenAI-Beta": "responses=experimental",
      });
    } catch {}
  }
  return undefined;
}

function add_source(sources: Map<string, Source>, value: unknown): void {
  const source = record(value);
  const url = http_url(source.url);
  if (url) {
    sources.set(url, {
      url,
      ...sources.get(url),
      ...(typeof source.title === "string" && source.title.trim()
        ? { title: source.title.trim() }
        : {}),
    });
  }
}

function normalize_text(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim();
}

function hosted_result(output: unknown[], num_results: number): ProviderResult {
  const sources = new Map<string, Source>();
  const parts: string[] = [];
  let searched = false;
  for (const value of output) {
    const item = record(value);
    if (
      item.error ||
      item.status === "failed" ||
      item.status === "incomplete"
    ) {
      throw new Error("Codex search returned a failed output item");
    }
    if (item.type === "web_search_call") {
      if (item.status !== "completed")
        throw new Error("Codex web search did not complete");
      searched = true;
      for (const source of list(record(item.action).sources))
        add_source(sources, source);
    }
    if (item.type !== "message" || item.role !== "assistant") continue;
    for (const value of list(item.content)) {
      const part = record(value);
      if (part.type !== "output_text") continue;
      if (typeof part.text === "string") parts.push(part.text);
      for (const value of list(part.annotations)) {
        const annotation = record(value);
        if (annotation.type === "url_citation") add_source(sources, annotation);
      }
    }
  }
  const text = normalize_text(parts.join("\n\n"));
  if (!searched || !text || !sources.size)
    throw new Error("Codex search returned no grounded results");
  const result = {
    text: text.slice(0, max_text_characters),
    sources: [...sources.values()].slice(0, num_results),
    truncated: text.length > max_text_characters || sources.size > num_results,
  };
  return result;
}

function native_result(raw: string, max_characters: number): ProviderResult {
  const data = record(JSON.parse(raw));
  if (data.error || typeof data.output !== "string")
    throw new Error("Codex page open failed");
  const sources = new Map<string, Source>();
  for (const value of list(data.results)) {
    const result = record(value);
    if (
      result.error ||
      result.type === "error" ||
      result.type === "error_result"
    ) {
      throw new Error("Codex page open returned a backend failure");
    }
    if (result.type === "text_result") add_source(sources, result);
  }
  const text = normalize_text(data.output);
  if (!text || !sources.size || !/^L\d+:[ \t]*\S/m.test(data.output)) {
    throw new Error("Codex page open returned no page content");
  }
  const result = {
    text: text.slice(0, max_characters),
    sources: [...sources.values()],
    truncated: text.length > max_characters,
  };
  return result;
}

function hosted_usage(
  value: unknown,
  model: Model<Api> | undefined,
): Usage | undefined {
  const data = record(value);
  if (
    typeof data.input_tokens !== "number" ||
    typeof data.output_tokens !== "number"
  )
    return undefined;
  const count = (value: unknown): number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : 0;
  const input_details = record(data.input_tokens_details);
  const cache_read = count(input_details.cached_tokens);
  const cache_write = count(input_details.cache_write_tokens);
  const input = count(data.input_tokens);
  const output = count(data.output_tokens);
  const usage: Usage = {
    input: Math.max(0, input - cache_read - cache_write),
    output,
    cacheRead: cache_read,
    cacheWrite: cache_write,
    reasoning: count(record(data.output_tokens_details).reasoning_tokens),
    totalTokens: count(data.total_tokens) || input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  if (model) calculateCost(model, usage);
  return usage;
}

export async function codex_provider(
  ctx: ExtensionContext,
  model?: string,
): Promise<SearchProvider | undefined> {
  if (!(await auth_headers(ctx, "application/json"))) return undefined;
  const selected_model =
    model?.replace(/^openai(?:-codex)?\//, "") ||
    (ctx.model && provider_names.includes(ctx.model.provider)
      ? ctx.model.id
      : undefined) ||
    provider_names.flatMap((provider) =>
      ctx.modelRegistry
        .getAll()
        .filter((candidate) => candidate.provider === provider),
    )[0]?.id;
  if (!selected_model) return undefined;
  const catalog_model = provider_names
    .map((provider) => ctx.modelRegistry.find(provider, selected_model))
    .find(Boolean);

  async function request(
    endpoint: "responses" | "alpha/search",
    body: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    signal.throwIfAborted();
    const headers = await auth_headers(
      ctx,
      endpoint === "responses" ? "text/event-stream" : "application/json",
    );
    signal.throwIfAborted();
    if (!headers) throw new Error("Codex OAuth is no longer available");
    return codex_request(endpoint, headers, body, signal);
  }

  return {
    name: "codex",
    async search({ query, numResults }, signal) {
      if (!query.trim() || query.length > 16_384)
        throw new Error("Invalid Codex search query");
      const count = numResults ?? 5;
      if (!Number.isInteger(count) || count < 1 || count > 20) {
        throw new Error("Codex result count must be between 1 and 20");
      }
      const raw = await request(
        "responses",
        {
          model: selected_model,
          instructions: "",
          input: [
            { role: "user", content: [{ type: "input_text", text: query }] },
          ],
          tools: [
            {
              type: "web_search",
              external_web_access: true,
              search_context_size: "medium",
            },
          ],
          tool_choice: "required",
          parallel_tool_calls: true,
          store: false,
          stream: true,
          include: ["web_search_call.action.sources"],
        },
        signal,
      );
      const response = responses_output(raw);
      const result = hosted_result(response.output, count);
      const usage = hosted_usage(response.usage, catalog_model);
      return { ...result, ...(usage ? { usage } : {}) };
    },
    async fetch({ url, maxCharacters }, signal) {
      const target = http_url(url);
      if (!target || url.length > 8192)
        throw new Error("Invalid Codex page URL");
      const limit = maxCharacters ?? 20_000;
      if (
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > max_text_characters
      ) {
        throw new Error(
          `Codex page character limit must be between 1 and ${max_text_characters}`,
        );
      }
      const raw = await request(
        "alpha/search",
        {
          id: crypto.randomUUID(),
          model: selected_model,
          input: target,
          commands: { open: [{ ref_id: target }], response_length: "long" },
          settings: {
            search_context_size: "medium",
            allowed_callers: ["direct"],
            external_web_access: true,
          },
          max_output_tokens: 8000,
        },
        signal,
      );
      return native_result(raw, limit);
    },
  };
}
