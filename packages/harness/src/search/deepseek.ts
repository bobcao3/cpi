import { json_request, public_url } from "./http.ts";
import type { ProviderResult, SearchProvider } from "./types.ts";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(/\0/g, "").trim()
    : "";
}

export function deepseek_provider(apiKey: string): SearchProvider {
  if (!apiKey.trim()) throw new Error("DeepSeek API key is empty");

  async function request(
    operation: "search" | "fetch",
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    signal.throwIfAborted();
    const result = await json_request(
      `https://api.deepseek.com/v1/tools/${operation}`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    signal.throwIfAborted();
    if (!record(result) || "error" in result)
      throw new Error("Invalid DeepSeek response");
    return result;
  }

  return {
    name: "deepseek",
    async search({ query, numResults = 10 }, signal) {
      if (!query.trim()) throw new Error("DeepSeek query is empty");
      let characters = 0;
      for (const _character of query) {
        if (++characters > 128)
          throw new Error("DeepSeek query exceeds 128 Unicode characters");
      }
      if (
        !Number.isSafeInteger(numResults) ||
        numResults < 1 ||
        numResults > 20
      )
        throw new Error("DeepSeek result count must be between 1 and 20");
      const response = await request(
        "search",
        { query, count: numResults, need_content: true },
        signal,
      );
      if (!Array.isArray(response.results))
        throw new Error("Invalid DeepSeek search response");
      const results: ProviderResult[] = [];
      const seen = new Set<string>();
      for (const item of response.results) {
        if (!record(item) || "error" in item || typeof item.url !== "string")
          continue;
        const content =
          clean(item.content) || clean(item.summary) || clean(item.snippet);
        if (!content) continue;
        let url: string;
        try {
          url = public_url(item.url).href;
        } catch {
          continue;
        }
        if (seen.has(url)) continue;
        seen.add(url);
        const title = clean(item.title);
        results.push({
          text: [title, url, content].filter(Boolean).join("\n"),
          sources: [{ url, ...(title ? { title } : {}) }],
        });
        if (results.length === numResults) break;
      }
      if (!results.length)
        throw new Error("DeepSeek returned no usable results");
      return {
        text: results.map((item) => item.text).join("\n\n"),
        sources: results.flatMap((item) => item.sources),
      };
    },
    async fetch({ url, maxCharacters }, signal) {
      if (
        maxCharacters !== undefined &&
        (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1)
      )
        throw new Error("DeepSeek character limit must be a positive integer");
      const parsed = public_url(url);
      if (parsed.href.length > 8192)
        throw new Error("DeepSeek fetch URL exceeds 8192 characters");
      const response = await request("fetch", { url: parsed.href }, signal);
      const text = clean(response.content);
      if (!text) throw new Error("DeepSeek returned no usable page content");
      const title = clean(response.title);
      return {
        text,
        sources: [{ url: parsed.href, ...(title ? { title } : {}) }],
      };
    },
  };
}
