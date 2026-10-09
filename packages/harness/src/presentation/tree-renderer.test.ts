import assert from "node:assert/strict";
import { test } from "node:test";
import { getThemeByName, initTheme } from "@earendil-works/pi-coding-agent";
import { adapt_tree_renderers } from "../lib/tree-execution.ts";
import type { ToolExecutionRenderContext } from "@earendil-works/pi-coding-agent";

initTheme("dark");
const theme = getThemeByName("dark")!;

test("cpi execution exports preserve disclosures and escape external labels and bodies", () => {
  const tool = adapt_tree_renderers({
    renderTree: () => [
      {
        id: 'root<&"',
        label: "Root <script>",
        summary: "Summary & more",
        metadata: ["meta > value"],
        defaultOpen: true,
        surface: { background: "toolPendingBg" as const, frame: true },
        content: {
          text: "body <b>unsafe</b>",
          format: "code" as const,
          language: 'ts"x',
        },
        children: [
          { id: "child", label: "Child", content: { text: "plain & text" } },
          {
            id: "image",
            label: "Attachment",
            content: {
              text: 'alt "<unsafe>',
              image: { data: "AA==", mimeType: "image/png" },
            },
          },
          {
            id: "unsafe-image",
            label: "Unsafe attachment",
            content: {
              text: "fallback",
              image: { data: '" onerror="alert(1)', mimeType: "image/png" },
            },
          },
        ],
      },
    ],
  });
  const context: ToolExecutionRenderContext = {
    toolCallId: "export",
    cwd: process.cwd(),
    state: {},
    invalidate() {},
    expanded: false,
    showImages: true,
    imageWidthCells: 60,
    outputPad: 1,
  };
  const html = tool.renderExecutionHtml!(
    { args: {}, phase: "complete", isError: false },
    theme,
    context,
  );
  assert.match(
    html,
    /<details[^>]+data-node-id="root&lt;&amp;&quot;"[^>]+open>/,
  );
  for (const text of [
    "Root &lt;script&gt;",
    "Summary &amp; more",
    "meta &gt; value",
    "body &lt;b&gt;unsafe&lt;/b&gt;",
    "plain &amp; text",
  ])
    assert.ok(html.includes(text), text);
  assert.match(html, /data-frame="true"/);
  assert.match(html, /src="data:image\/png;base64,AA=="/);
  assert.match(html, /alt="alt &quot;&lt;unsafe&gt;"/);
  assert.ok(html.includes("fallback"));
  assert.doesNotMatch(html, /<script>|onerror=|\x1b|tool-header/);
});
