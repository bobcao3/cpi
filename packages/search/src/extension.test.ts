import { expect, test } from "bun:test";
import {
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from "../../../.pi-fork/packages/ai/src/index.ts";
import {
  createHarness,
  getToolResult,
} from "../../../.pi-fork/packages/coding-agent/test/suite/harness.ts";
import { createCodemodeExtension } from "../../../.pi-fork/packages/coding-agent/src/extensions/codemode/index.ts";
import search_extension from "./index.ts";

test("search tools stay codemode-only even when activated and reject invalid calls through nested execution", async () => {
  const harness = await createHarness({
    initialActiveToolNames: ["codemode"],
    extensionFactories: [search_extension, createCodemodeExtension()],
  });
  try {
    harness.session.setActiveToolsByName([
      "codemode",
      "search_query",
      "web_fetch",
    ]);
    let declared: string[] = [];
    harness.setResponses([
      (context) => {
        declared = getCurrentTools(context.messages).map((tool) => tool.name);
        return fauxAssistantMessage(
          [
            fauxToolCall("codemode", {
              code: `
              const failures = [];
              for (const [name, input] of [
                ["search_query", {query: "  "}],
                ["web_fetch", {url: "file:///etc/passwd"}],
                ["web_fetch", {url: "https://user:password@example.com/"}]
              ]) {
                try { await tools[name](input); }
                catch(error) { failures.push({name, message:error.message}); }
              }
              text(failures);
            `,
            }),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("done"),
    ]);
    await harness.session.prompt("Validate codemode search calls");
    expect(declared).toEqual(["codemode"]);
    const result = getToolResult(harness, "codemode");
    expect(result.isError).not.toBe(true);
    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    expect(text).toContain("Script completed");
    expect(text).toContain("HTTP(S) URL without credentials");
    expect(
      result.nestedCalls?.calls.map((call) => [call.name, call.status]),
    ).toEqual([
      ["search_query", "error"],
      ["web_fetch", "error"],
      ["web_fetch", "error"],
    ]);
  } finally {
    harness.cleanup();
  }
});
