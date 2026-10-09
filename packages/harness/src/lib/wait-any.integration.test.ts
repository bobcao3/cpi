import { expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const coding_dir = dirname(
  fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const { loadExtensions } = await import(
  resolve(coding_dir, "core/extensions/loader.js")
);
const { ToolExecutionComponent } = await import(
  resolve(coding_dir, "modes/interactive/components/tool-execution.js")
);
const { initTheme } = await import(
  resolve(coding_dir, "modes/interactive/theme/theme.js")
);

test("wait_any shows one timestamp while preserving its model-facing result", async () => {
  const loaded = await loadExtensions(
    [fileURLToPath(new URL("../wait-any.ts", import.meta.url))],
    process.cwd(),
  );
  expect(loaded.errors).toEqual([]);
  const tool = loaded.extensions[0].tools.get("wait_any")!.definition;
  const result = await tool.execute(
    "wait-display",
    {},
    undefined,
    undefined,
    {} as any,
  );
  expect(result.terminate).toBe(true);
  expect(result.content).toHaveLength(1);
  expect(result.content[0].type).toBe("text");
  expect((result.content[0] as { text: string }).text).toMatch(
    /\d{2}\/\d{2}\/\d{2} \d{1,2}:\d{2} [AP]M \S+/,
  );
  initTheme("dark");
  const display = new ToolExecutionComponent(
    "wait_any",
    "wait-display",
    {},
    {},
    tool,
    { requestRender() {} } as any,
    process.cwd(),
  );
  display.updateResult(result);
  for (const expanded of [false, true]) {
    display.setExpanded(expanded);
    const text = display.render(160).map(stripVTControlCharacters).join("\n");
    expect(text).toContain("waiting on events or user input");
    expect(text.match(/\d{2}\/\d{2}\/\d{2}/g)).toHaveLength(1);
  }
  display.updateResult({
    content: [{ type: "text", text: "Waiting was blocked" }],
    details: undefined,
    isError: true,
  });
  expect(
    display.render(160).map(stripVTControlCharacters).join("\n"),
  ).toContain("Waiting was blocked");
});
