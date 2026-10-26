import { json_request, public_url } from "./http.ts";
import { fetch_public_page } from "./public-fetch.ts";
import type { SearchProvider } from "./types.ts";

export function searxng_provider(endpoint: string): SearchProvider {
  const base = public_url(endpoint);
  base.hash = "";
  base.search = "";
  base.pathname = base.pathname.replace(/\/?$/, "/");
  return {
    name: "searxng",
    async search(input, signal) {
      const url = new URL("search", base);
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      const result = await json_request(url, {
        signal,
        headers: { accept: "application/json" },
      });
      if (
        !result ||
        typeof result !== "object" ||
        !("results" in result) ||
        !Array.isArray(result.results)
      )
        throw new Error("Invalid SearXNG search response");
      const results = result.results
        .filter((item) => {
          if (!item || typeof item.url !== "string") return false;
          try {
            public_url(item.url);
            return true;
          } catch {
            return false;
          }
        })
        .slice(0, input.numResults ?? 10);
      if (!results.length)
        throw new Error("SearXNG returned no usable results");
      return {
        text: results
          .map((item) =>
            [
              typeof item.title === "string" ? item.title : "",
              item.url,
              typeof item.content === "string" ? item.content : "",
            ]
              .filter(Boolean)
              .join("\n"),
          )
          .join("\n\n"),
        sources: results.map((item) => ({
          url: item.url,
          ...(typeof item.title === "string" ? { title: item.title } : {}),
        })),
      };
    },
    fetch: (input, signal) => fetch_public_page(input.url, signal),
  };
}
