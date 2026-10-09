import { ToolTreeComponent } from "./tree/index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getThemeByName, initTheme } from "@earendil-works/pi-coding-agent";
import { createRepeatTool } from "./shell/repeat-tool.ts";
import { getActiveRepeats, killAllRepeats } from "./shell/repeat.ts";
import { setCurrentScope } from "./shell/exec.ts";
import { ensureShellTools } from "./shell/tools.ts";
import { resolveShell } from "./shell/profile.ts";

initTheme("dark");
const theme = getThemeByName("dark")!;
test("real monitor launch and rejected commands retain separate semantic outcomes", async () => {
  const callId = crypto.randomUUID();
  setCurrentScope(callId);
  const tool = createRepeatTool(
    120,
    await ensureShellTools(),
    resolveShell("bash"),
  );
  const context = {
    toolCallId: callId,
    cwd: process.cwd(),
    state: {},
    viewState: { open: new Map(), shownChildren: new Map() },
    invalidate() {},
  };
  try {
    for (const command of ["true", "mkfs.ext4 /dev/sdb1"]) {
      const args = { command, interval: 5, description: "Inspect monitor" };
      const result = await tool.execute(
        callId,
        args,
        undefined,
        undefined,
        undefined!,
      );
      const nodes = tool.renderTree!(
        { args, result, phase: "complete", isError: !!result.isError },
        theme,
        context,
      );
      const root = nodes[0]!;
      const blocked = root.children?.find((node) =>
        node.id.endsWith("/blocked"),
      );
      if (command === "true") {
        assert.equal(root.status, "success");
        assert.equal(blocked, undefined);
        const monitor = getActiveRepeats().find(
          (entry) => entry.id === result.details.id,
        );
        assert.ok(monitor);
        assert.ok(
          root.children?.some((node) => node.label.includes(monitor.id)),
        );
      } else {
        assert.equal(root.status, "error");
        assert.ok(result.details.blocked?.includes("filesystem formatting"));
        assert.equal(blocked?.content?.text, result.details.blocked?.trim());
        assert.equal(blocked?.defaultOpen, false);
      }
      const tree = new ToolTreeComponent(nodes, theme, { padding: 0 });
      assert.ok(tree.render(100).join("\n").includes("Inspect monitor"));
      assert.equal(
        root.children?.find((node) => node.id.endsWith("/command"))?.content
          ?.text,
        command,
      );
    }
  } finally {
    killAllRepeats();
  }
});
