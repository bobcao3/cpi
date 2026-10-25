import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ProviderResult, SearchProvider, Source } from "./types.ts";

const endpoint = "https://mcp.exa.ai/mcp";
const timeout_ms = 45_000;
const response_limit = 4 * 1024 * 1024;

function normalize_result(result: CallToolResult): ProviderResult {
  if (result.isError) throw new Error("Exa tool returned an error");
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\0/g, "")
    .trim();
  const sources = new Map<string, Source>();
  const header =
    /^(?:Title: ([^\n]*)\n|# ([^\n]*)\n)?URL:\s*(https?:\/\/[^\s]+)[^\n]*/gm;
  const body = text.replace(
    header,
    (_match, search_title, fetch_title, raw_url) => {
      try {
        const url = new URL(raw_url);
        if (url.username || url.password) return "";
        const title = (search_title || fetch_title || "").trim();
        sources.set(url.href, {
          url: url.href,
          ...(title && title !== "N/A" && title !== "(no title)"
            ? { title }
            : {}),
        });
      } catch {}
      return "";
    },
  );
  const useful = body
    .replace(/^(?:Published|Author):[^\n]*$/gm, "")
    .replace(/^(?:Highlights|Text):\s*/gm, "")
    .replace(/^\s*---\s*$/gm, "")
    .trim();
  if (!useful || sources.size === 0)
    throw new Error("Exa returned no usable content");
  return { text, sources: [...sources.values()] };
}

async function call_tool(
  api_key: string | undefined,
  name: string,
  arguments_: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ProviderResult> {
  signal.throwIfAborted();
  const lifetime = new AbortController();
  const deadline = setTimeout(
    () => lifetime.abort(new Error("Exa operation timed out")),
    timeout_ms,
  );
  const operation = AbortSignal.any([signal, lifetime.signal]);
  const client = new Client({ name: "cpi-search", version: "1.0.0" });
  let bytes = 0;
  const bounded_fetch: FetchLike = async (url, init) => {
    if (url.toString() !== endpoint) throw new Error("Unexpected Exa endpoint");
    const request_signal = AbortSignal.any([
      operation,
      ...(init?.signal ? [init.signal] : []),
    ]);
    request_signal.throwIfAborted();
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: request_signal,
    });
    if (!response.body) return response;
    const body = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          if (bytes > response_limit) {
            const error = new Error("Exa response exceeded byte limit");
            lifetime.abort(error);
            throw error;
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: bounded_fetch,
    requestInit: { headers: api_key ? { "x-api-key": api_key } : {} },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1_000,
      maxReconnectionDelay: 1_000,
      reconnectionDelayGrowFactor: 1,
    },
  });
  client.onerror = (error) => lifetime.abort(error);
  try {
    await client.connect(transport, { signal: operation, timeout: timeout_ms });
    const result = await client.request(
      { method: "tools/call", params: { name, arguments: arguments_ } },
      CallToolResultSchema,
      {
        signal: operation,
        timeout: timeout_ms,
      },
    );
    operation.throwIfAborted();
    return normalize_result(result);
  } finally {
    lifetime.abort();
    clearTimeout(deadline);
    await client.close();
  }
}

function positive_integer(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new Error("Exa limits must be positive integers");
  }
}

export function exa_provider(
  apiKey: string | undefined = process.env.EXA_API_KEY,
): SearchProvider {
  return {
    name: "exa",
    async search({ query, numResults }, signal) {
      if (!query.trim()) throw new Error("Exa query is empty");
      positive_integer(numResults);
      return call_tool(
        apiKey,
        "web_search_exa",
        {
          query,
          objective: query,
          ...(numResults === undefined ? {} : { numResults }),
        },
        signal,
      );
    },
    async fetch({ url, maxCharacters }, signal) {
      const parsed = new URL(url);
      if (
        !["http:", "https:"].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      ) {
        throw new Error(
          "Exa fetch requires an HTTP(S) URL without credentials",
        );
      }
      positive_integer(maxCharacters);
      return call_tool(
        apiKey,
        "web_fetch_exa",
        {
          urls: [parsed.href],
          ...(maxCharacters === undefined
            ? {}
            : { maxCharacters: maxCharacters + 1 }),
        },
        signal,
      );
    },
  };
}
