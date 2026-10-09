import { ToolTreeComponent } from "../tree/index.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@earendil-works/pi-coding-agent";
import { killAll, runShell, setCurrentScope } from "./exec.ts";
import { renderShellTree } from "./compact-render.ts";

initTheme("dark");
const theme = getThemeByName("dark")!;
test("real shell results retain compact success and independently inspectable failure", async () => {
  const session = crypto.randomUUID();
  setCurrentScope(session);
  try {
    for (const exit of [0, 7]) {
      const args = {
        description: "Inspect shell status",
        command: `printf 'private-output\\nsecond\\n'; exit ${exit}`,
        waitfor: 30,
      };
      const result = await runShell(
        args.command,
        args.waitfor,
        { ...process.env, PI_SESSION_ID: session },
        undefined,
        undefined,
        args.description,
        30,
        { maxLines: 100 },
        { previewMaxBytes: 8192, maxAcc: 8192, updateMs: 100 },
      );
      assert.equal(result.exitCode, exit);
      const snapshot = {
        args,
        phase: "complete" as const,
        isError: exit !== 0,
        result: {
          content: [{ type: "text" as const, text: result.text }],
          details: { ...result, describe: args.description, shellName: "bash" },
        },
      };
      const nodes = renderShellTree(snapshot, theme, { toolCallId: session });
      const root = nodes[0]!;
      assert.equal(root.status, exit === 0 ? "success" : "error");
      const command = root.children!.find((node) =>
        node.id.endsWith("/command"),
      )!;
      assert.equal(command.content?.text, args.command);
      const failure = root.children!.find((node) =>
        node.id.endsWith("/failure"),
      );
      if (exit === 0) {
        assert.equal(failure, undefined);
        assert.ok(
          root.children!.every(
            (node) =>
              node.id.endsWith("/command") ||
              !node.content?.text.includes("private-output"),
          ),
        );
      } else assert.ok(failure?.content?.text.includes("private-output"));
      const tree = new ToolTreeComponent(nodes, theme, { padding: 0 });
      const compact = tree.render(100).map(stripVTControlCharacters).join("\n");
      assert.ok(!compact.includes("private-output"));
      assert.ok(!compact.includes(args.command));
      if (exit !== 0) {
        assert.ok(compact.includes("exit 7"));
        tree.getState().open.set(root.id, true);
        tree.update(nodes, theme);
        assert.ok(
          !tree
            .render(100)
            .map(stripVTControlCharacters)
            .join("\n")
            .includes("private-output"),
        );
        tree.getState().open.set(failure!.id, true);
        tree.update(nodes, theme);
        assert.ok(
          tree
            .render(100)
            .map(stripVTControlCharacters)
            .join("\n")
            .includes("private-output"),
        );
      }
      tree.getState().open.set(command.id, true);
      tree.getState().open.set(root.id, true);
      tree.update(
        renderShellTree(snapshot, theme, { toolCallId: session }),
        theme,
      );
      assert.equal(tree.getState().open.get(command.id), true);
    }
  } finally {
    await killAll();
  }
});
