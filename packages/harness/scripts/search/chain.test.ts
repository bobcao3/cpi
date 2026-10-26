import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { ENV_AGENT_DIR } from "../../../../.pi-fork/packages/coding-agent/src/config.ts";
import {
  createHarness,
  getToolResult,
} from "../../../../.pi-fork/packages/coding-agent/test/suite/harness.ts";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "../../../../.pi-fork/packages/ai/src/index.ts";
import { createCodemodeExtension } from "../../../../.pi-fork/packages/coding-agent/src/extensions/codemode/index.ts";
import { search_config } from "../../src/search/config.ts";
import search_extension from "../../src/search/index.ts";

async function fixture(
  run: (state: {
    harness: Awaited<ReturnType<typeof createHarness>>;
    user: string;
    project: string;
    endpoint: string;
    requests: string[];
  }) => Promise<void>,
) {
  const keys = [
    ENV_AGENT_DIR,
    "CPI_SEARCH_PROVIDERS",
    "CPI_SEARCH_SEARXNG_URL",
    "SEARXNG_URL",
    "DEEPSEEK_API_KEY",
  ];
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  const harness = await createHarness({
    initialActiveToolNames: ["codemode"],
    extensionFactories: [search_extension, createCodemodeExtension()],
  });
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        results: [
          {
            url: "https://example.org/source",
            title: "Source",
            content: "local result",
          },
        ],
      }),
    );
  });
  try {
    const user = join(harness.tempDir, "agent");
    const project = join(harness.tempDir, ".cpi");
    mkdirSync(user);
    mkdirSync(project);
    process.env[ENV_AGENT_DIR] = user;
    harness.settingsManager.setProjectTrusted(true);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    await run({
      harness,
      user: join(user, "search.json"),
      project: join(project, "search.json"),
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      requests,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    harness.cleanup();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("provider configuration replaces lists and honors project trust and environment precedence", async () => {
  await fixture(async ({ harness, user, project, endpoint }) => {
    writeFileSync(
      user,
      JSON.stringify({ providers: ["searxng"], searxngUrl: endpoint }),
    );
    writeFileSync(
      project,
      JSON.stringify({ providers: ["deepseek", "searxng"] }),
    );
    expect(search_config(harness.tempDir, false).providers).toEqual([
      "searxng",
    ]);
    expect(search_config(harness.tempDir, true).providers).toEqual([
      "deepseek",
      "searxng",
    ]);
    process.env.CPI_SEARCH_PROVIDERS = "exa, codex";
    expect(search_config(harness.tempDir, true).providers).toEqual([
      "exa",
      "codex",
    ]);
    delete process.env.CPI_SEARCH_PROVIDERS;
    for (const providers of [
      [],
      ["unknown"],
      ["exa", "exa"],
      "deepseek",
      null,
    ]) {
      writeFileSync(project, JSON.stringify({ providers }));
      expect(() => search_config(harness.tempDir, true)).toThrow(
        "Search providers",
      );
      expect(search_config(harness.tempDir, false).providers).toEqual([
        "searxng",
      ]);
    }
  });
});

test("codemode uses the configured chain and skips unavailable opt-in credentials", async () => {
  await fixture(async ({ harness, project, endpoint, requests }) => {
    for (const providers of [
      ["searxng"],
      ["deepseek", "searxng"],
      ["deepseek"],
    ]) {
      writeFileSync(
        project,
        JSON.stringify({ providers, searxngUrl: endpoint }),
      );
      const prior = requests.length;
      harness.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: 'text(await tools.search_query({query:"chain check"}));',
            }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("done"),
      ]);
      await harness.session.prompt("check");
      const result = getToolResult(harness, "codemode");
      const text = result.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (providers.includes("searxng")) {
        expect(result.isError).not.toBe(true);
        expect(text).toContain('"provider":"searxng"');
        expect(text).toContain('"attempts":[]');
        expect(text).toContain("local result");
        expect(requests.length).toBe(prior + 1);
        expect(new URL(requests.at(-1)!, endpoint).searchParams.get("q")).toBe(
          "chain check",
        );
      } else {
        expect(result.isError).toBe(true);
        expect(text).toContain("No configured search provider is available");
        expect(requests.length).toBe(prior);
      }
    }
  });
});
