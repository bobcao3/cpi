import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import shell from "../shell.ts";
import { renderCompactShellResult } from "./compact-render.ts";

const theme = getThemeByName("dark")!;
const plain = (component: { render(width: number): string[] }) =>
  component
    .render(120)
    .map((line) => stripVTControlCharacters(line).trimEnd())
    .join("\n");

function host() {
  const tools = new Map<string, any>();
  const pi: any = {
    getActiveTools: () => [],
    getAllTools: () => [],
    setActiveTools: () => {},
    registerTool: (tool: any) => tools.set(tool.name, tool),
    on: () => {},
    registerMessageRenderer: () => {},
  };
  return { pi, tools };
}

test("rejected sh command renders Blocked with its reason, not failed", async () => {
  const { pi, tools } = host();
  await shell(pi);
  const sh = tools.get("sh");
  assert.ok(sh, "sh tool registered");

  const args = { description: "format a disk", command: "mkfs.ext4 /dev/sdb1" };
  const result = await sh.execute("id", args, undefined, undefined, {});
  assert.equal(result.isError, true);
  assert.match(result.details.blocked, /filesystem formatting/);
  assert.equal(
    plain(
      renderCompactShellResult(
        result,
        { isPartial: false },
        theme,
        { args, isError: true },
        "zsh",
      ),
    ),
    "🛑 Blocked: format a disk\n  - Reason: L1:1 reject[no-mkfs] filesystem formatting",
  );
});

test("non-rejecting commands still render success and failure", async () => {
  const { pi, tools } = host();
  await shell(pi);
  const sh = tools.get("sh");

  for (const [command, expected] of [
    ["true", "✓ zsh: ok"],
    ["false", "✗ zsh: fail"],
  ] as const) {
    const args = { description: command === "true" ? "ok" : "fail", command };
    const result = await sh.execute("id", args, undefined, undefined, {});
    const rendered = plain(
      renderCompactShellResult(
        result,
        { isPartial: false },
        theme,
        { args, isError: !!result.isError },
        "zsh",
      ),
    );
    assert.ok(
      rendered.startsWith(expected),
      `${command} rendered as ${JSON.stringify(rendered)}`,
    );
    assert.ok(!rendered.includes("🛑"));
  }
});

test("waitfor and inline sleep guards render Blocked", async () => {
  const { pi, tools } = host();
  await shell(pi);
  const sh = tools.get("sh");

  for (const args of [
    { description: "too long", command: "echo hi", waitfor: 9999 },
    { description: "inline sleep", command: "sleep 400 && echo done" },
  ]) {
    const result = await sh.execute("id", args, undefined, undefined, {});
    assert.equal(result.isError, true);
    assert.equal(typeof result.details.blocked, "string");
    assert.ok(
      plain(
        renderCompactShellResult(
          result,
          { isPartial: false },
          theme,
          { args, isError: true },
          "zsh",
        ),
      ).startsWith(`🛑 Blocked: ${args.description}\n  - Reason: `),
    );
  }
});
