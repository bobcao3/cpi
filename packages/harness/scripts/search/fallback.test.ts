import { expect, test } from "bun:test";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { json_request } from "../../src/search/http.ts";
import { fetch_public_page } from "../../src/search/public-fetch.ts";
import { route, type ProviderFactory } from "../../src/search/route.ts";
import { searxng_provider } from "../../src/search/searxng.ts";

const query = "café & ports / 中文?";
const results = [
  null,
  { url: "file:///etc/passwd", title: "Not a web result" },
  { url: "https://user:secret@example.org/", title: "Credentials" },
  {
    title: "Café handbook",
    url: "https://docs.example.org/guide?x=1&y=2",
    content: "First snippet with Unicode: 中文.",
  },
  { url: "https://example.net/second", content: "Second snippet." },
];
const sources = [
  { title: "Café handbook", url: "https://docs.example.org/guide?x=1&y=2" },
  { url: "https://example.net/second" },
];

interface ObservedRequest {
  path: string;
  query: string | null;
  format: string | null;
  method: string | undefined;
  accept: string | undefined;
}

async function with_server(
  run: (fixture: {
    origin: string;
    port: number;
    requests: ObservedRequest[];
    server: ReturnType<typeof createServer>;
    signal: AbortSignal;
    providers: (...paths: string[]) => ProviderFactory[];
  }) => Promise<void>,
) {
  const requests: ObservedRequest[] = [];
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error("Test deadline exceeded")),
    2500,
  );
  const server = createServer((request: IncomingMessage, response) => {
    const url = new URL(request.url!, "http://fixture.invalid");
    requests.push({
      path: url.pathname,
      query: url.searchParams.get("q"),
      format: url.searchParams.get("format"),
      method: request.method,
      accept: request.headers.accept,
    });
    response.setHeader("content-type", "application/json");
    switch (url.pathname) {
      case "/failed/search":
        response.writeHead(503);
        response.end('{"error":"backend unavailable"}');
        return;
      case "/empty/search":
        response.end('{"results":[]}');
        return;
      case "/invalid/search":
        response.end('{"results":');
        return;
      case "/schema/search":
        response.end('{"results":{}}');
        return;
      case "/headers/search":
        return;
      case "/body/search":
        response.writeHead(200);
        response.flushHeaders();
        response.write('{"results":[');
        return;
      case "/limit/search":
      case "/oversized/search": {
        const size =
          2 * 1024 * 1024 + Number(url.pathname.startsWith("/oversized"));
        const prefix = '{"text":"';
        const suffix = '"}';
        const content_bytes = size - prefix.length - suffix.length;
        const body = Buffer.concat([
          Buffer.from(prefix),
          Buffer.from(
            "é".repeat(Math.floor(content_bytes / 2)) +
              "x".repeat(content_bytes % 2),
          ),
          Buffer.from(suffix),
        ]);
        response.write(body);
        response.end();
        return;
      }
      default:
        response.end(JSON.stringify({ results }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "::", resolve);
    });
    const port = (server.address() as AddressInfo).port;
    const origin = `http://127.0.0.1:${port}`;
    await run({
      origin,
      port,
      requests,
      server,
      signal: controller.signal,
      providers: (...paths) =>
        paths.map((path) => ({
          name: "searxng",
          create: () =>
            searxng_provider(`${origin}/${path}?discard=1#fragment`),
        })),
    });
  } finally {
    clearTimeout(deadline);
    controller.abort();
    const closing = new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server.closeAllConnections();
    await closing;
  }
}

const search = (
  provider: ReturnType<typeof searxng_provider>,
  signal: AbortSignal,
) => provider.search({ query, numResults: 2 }, signal);

for (const stall of ["headers", "body"]) {
  test(`SearXNG failover preserves HTTP, empty, ${stall} timeout ordering and JSON protocol`, async () => {
    await with_server(async ({ requests, providers, signal }) => {
      const result = await route(
        providers("failed", "empty", stall, "ok", "unused"),
        search,
        250,
        1000,
        signal,
      );
      expect(requests.map((request) => request.path)).toEqual([
        "/failed/search",
        "/empty/search",
        `/${stall}/search`,
        "/ok/search",
      ]);
      for (const request of requests) {
        expect(request).toMatchObject({
          query,
          format: "json",
          method: "GET",
          accept: "application/json",
        });
      }
      expect(result).toEqual({
        provider: "searxng",
        text: "Café handbook\nhttps://docs.example.org/guide?x=1&y=2\nFirst snippet with Unicode: 中文.\n\nhttps://example.net/second\nSecond snippet.",
        sources,
        truncated: false,
        attempts: [
          { provider: "searxng", error: "HTTP 503" },
          {
            provider: "searxng",
            error: "Provider failed or returned no usable content",
          },
          { provider: "searxng", error: "Provider timed out" },
        ],
      });
    });
  });
}

test("SearXNG malformed JSON and invalid response schema fall through to a usable endpoint", async () => {
  await with_server(async ({ requests, providers, signal }) => {
    const result = await route(
      providers("invalid", "schema", "ok"),
      search,
      1000,
      1000,
      signal,
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/invalid/search",
      "/schema/search",
      "/ok/search",
    ]);
    expect(result.sources).toEqual(sources);
    expect(result.attempts).toHaveLength(2);
    expect(result.truncated).toBe(false);
  });
});

test("route truncates returned text without losing source attribution", async () => {
  await with_server(async ({ providers, signal }) => {
    const result = await route(providers("ok"), search, 1000, 20, signal);
    expect(result.text).toBe("Café handbook\nhttps:");
    expect(result.truncated).toBe(true);
    expect(result.sources).toEqual(sources);
    expect(result.attempts).toEqual([]);
  });
});

test("SearXNG numResults limits valid results rather than counting rejected URLs", async () => {
  await with_server(async ({ providers, signal }) => {
    const result = await route(
      providers("ok"),
      (provider, attempt_signal) =>
        provider.search({ query, numResults: 1 }, attempt_signal),
      1000,
      1000,
      signal,
    );
    expect(result.sources).toEqual([sources[0]]);
    expect(result.text).toBe(
      "Café handbook\nhttps://docs.example.org/guide?x=1&y=2\nFirst snippet with Unicode: 中文.",
    );
  });
});

for (const phase of ["before request", "during body"]) {
  test(`caller cancellation ${phase} prevents the next provider from starting`, async () => {
    await with_server(async ({ providers, requests, server, signal }) => {
      const caller = new AbortController();
      const reason = new Error("Caller cancelled search");
      const abort = () => caller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (phase === "before request") caller.abort(reason);
        else
          server.once("request", (_request, response) => {
            response.write("", () => caller.abort(reason));
          });
        await expect(
          route(providers("body", "unused"), search, 1000, 1000, caller.signal),
        ).rejects.toBe(reason);
        expect(requests.map((request) => request.path)).toEqual(
          phase === "before request" ? [] : ["/body/search"],
        );
      } finally {
        caller.abort();
        signal.removeEventListener("abort", abort);
      }
    });
  });
}

test("exhausting real HTTP, empty and stalled endpoints reports all failures", async () => {
  await with_server(async ({ providers, requests, signal }) => {
    await expect(
      route(providers("failed", "empty", "body"), search, 250, 1000, signal),
    ).rejects.toThrow(
      /All search providers failed:.*HTTP 503.*no usable content.*Provider timed out/,
    );
    expect(requests.map((request) => request.path)).toEqual([
      "/failed/search",
      "/empty/search",
      "/body/search",
    ]);
  });
});

test("HTTP JSON reads accept 2 MiB but reject a valid JSON body one byte larger", async () => {
  await with_server(async ({ origin, signal, requests }) => {
    const result = (await json_request(`${origin}/limit/search`, {
      signal,
    })) as { text: string };
    expect(Buffer.byteLength(JSON.stringify(result))).toBe(2 * 1024 * 1024);
    await expect(
      json_request(`${origin}/oversized/search`, { signal }),
    ).rejects.toThrow("Response exceeds byte limit");
    expect(requests.map((request) => request.path)).toEqual([
      "/limit/search",
      "/oversized/search",
    ]);
  });
});

test("public page retrieval rejects private IPv4, IPv6, mapped addresses and localhost before HTTP", async () => {
  await with_server(async ({ port, signal, requests }) => {
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "localhost",
    ]) {
      const control = await json_request(
        `http://${host}:${port}/control/search`,
        { signal },
      );
      expect(control).toEqual({ results });
    }
    expect(requests).toHaveLength(4);
    requests.length = 0;
    for (const host of [
      "127.0.0.1",
      "10.0.0.1",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "[::1]",
      "[fc00::1]",
      "[fe80::1]",
      "[::ffff:127.0.0.1]",
      "[::ffff:c0a8:101]",
      "localhost",
    ]) {
      await expect(
        fetch_public_page(`http://${host}:${port}/must-not-arrive`, signal),
      ).rejects.toThrow("Page URL must resolve only to public addresses");
    }
    expect(requests).toEqual([]);
  });
});
