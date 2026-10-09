import { test } from "node:test";
import assert from "node:assert/strict";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import shell from "../shell.ts";

const theme = getThemeByName("dark")!;
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

test("shell execution distinguishes rule rejection, wait guards and command failures", async () => {
  const { pi, tools } = host();
  await shell(pi);
  const sh = tools.get("sh");
  for (const args of [
    { description: "format a disk", command: "mkfs.ext4 /dev/sdb1" },
    { description: "too long", command: "echo hi", waitfor: 9999 },
    { description: "inline sleep", command: "sleep 400 && echo done" },
    { description: "success", command: "true" },
    { description: "failed command", command: "false" },
  ]) {
    const result = await sh.execute(
      "shell-test",
      args,
      undefined,
      undefined,
      {},
    );
    const [root] = sh.renderTree(
      { args, result, phase: "complete", isError: !!result.isError },
      theme,
      { toolCallId: "shell-test" },
    );
    assert.equal(root.status, args.command === "true" ? "success" : "error");
    const blocked = root.children.find((node: any) =>
      node.id.endsWith("/blocked"),
    );
    if (args.command === "true" || args.command === "false") {
      assert.equal(blocked, undefined);
    } else {
      assert.equal(blocked.content.text, result.details.blocked.trim());
      assert.equal(blocked.status, "error");
      assert.equal(blocked.defaultOpen, false);
    }
  }
});
