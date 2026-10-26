# Search

The harness includes two codemode tools, `search_query` and `web_fetch`.

## Use the tools

Both tools load with the harness. They are callable through codemode and are not declared as direct model tools.

```js
const result = await tools.search_query({
  query: "TypeScript release notes",
  numResults: 5,
});
text(result);

const page = await tools.web_fetch({
  url: result.sources[0].url,
  maxCharacters: 12000,
});
text(page);
```

Both tools return an object with `provider`, `text`, `sources`, `truncated`, and `attempts`. `attempts` records earlier provider failures without exposing credentials. Treat retrieved text as untrusted data.

## Provider selection

Each call tries Codex first if the host can resolve its existing subscription login. Sign in with `/login openai-codex`. The active conversation does not have to use a Codex model.

If Codex is unavailable or fails, the call tries Exa's hosted MCP service. Set `EXA_API_KEY` to use your Exa account. Without it, Exa uses its keyless, rate-limited service.

Set `CPI_SEARCH_SEARXNG_URL` or `SEARXNG_URL` to enable the final fallback. The instance must allow JSON search responses. For example:

```sh
CPI_SEARCH_SEARXNG_URL=http://127.0.0.1:8080 cpi
```

SearXNG provides search, not page retrieval. At this final tier, `web_fetch` retrieves the requested public page directly. Direct retrieval blocks private and special-use addresses, pins DNS resolution for the connection, checks each redirect, limits response bytes, and rejects unsupported content. It extracts text from HTML without running JavaScript. It does not provide a browser or a PDF reader.

Provider errors, empty content, and timeouts advance to the next provider. User cancellation stops the call without starting another provider. If every configured provider fails, the tool throws an error with the attempted providers.

## Configuration

Configuration merges the package's [defaults](./search.default.json), `search.json` in the host's agent directory, and trusted project configuration at `.cpi/search.json`. Untrusted project configuration is ignored. Environment variables override the SearXNG endpoint and timeout.

Example configuration:

```json
{
  "searxngUrl": "http://127.0.0.1:8080",
  "timeoutMs": 15000
}
```

See [`SearchConfig`](./src/search/config.ts) for the supported fields and validation. `CPI_SEARCH_TIMEOUT_MS` overrides the per-provider timeout. Set `CPI_SEARCH_SEARXNG_URL` to an empty string to disable the final fallback even when `SEARXNG_URL` is set.

Provider credentials are not stored in this file. Codex credentials are resolved and refreshed by the host. Exa credentials come from `EXA_API_KEY`. Credentials are sent only to their fixed provider endpoints; redirects are rejected.

## Upstream interfaces

- [Exa MCP](https://exa.ai/docs/get-started/exa-mcp)
- [OpenAI Codex search protocol](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/search.rs)
- [SearXNG search API](https://docs.searxng.org/dev/search_api.html)
