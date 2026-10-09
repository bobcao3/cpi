import {
  getMarkdownTheme,
  highlightCode,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ToolTreeContent, ToolTreeNode } from "../tree/index.ts";
import { ansiToHtml } from "./ansi-to-html.ts";
import { treeStyles } from "./tree-styles.ts";

function escapeHtml(value: string): string {
  return stripTerminalSequences(value.slice(0, 200_000)).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!,
  );
}

function styledHtml(value: string): string {
  const sgr = /^\x1b\[[\d;]*m$/;
  return ansiToHtml(
    value
      .slice(0, 200_000)
      .split(/(\x1b\[[\d;]*m)/)
      .map((part) => (sgr.test(part) ? part : stripTerminalSequences(part)))
      .join(""),
  );
}

function contentHtml(content: ToolTreeContent, theme?: Theme): string {
  if (content.renderHtml) {
    try {
      const html = content.renderHtml();
      if (html.length <= 2_000_000) return html;
    } catch {}
  }
  const image = content.image;
  if (
    image &&
    /^image\/(png|jpeg|gif|webp)$/.test(image.mimeType) &&
    image.data.length <= 8_000_000 &&
    /^[A-Za-z0-9+/=\s]+$/.test(image.data)
  )
    return `<img class="tool-tree-image" alt="${escapeHtml(content.text)}" src="data:${image.mimeType};base64,${image.data.replace(/\s/g, "")}">`;
  const source = stripTerminalSequences(content.text.slice(0, 200_000));
  const notice =
    content.text.length > 200_000
      ? "<p>Display text limit; further content is unavailable in this export.</p>"
      : "";
  const language = content.language
    ? ` class="language-${escapeHtml(content.language)}"`
    : "";
  if (content.format === "code" || content.format === "diff") {
    const highlighted =
      content.format === "diff"
        ? renderDiff(source, {
            theme,
            language: content.language,
            lineNumbers: content.diffLineNumbers,
          })
        : highlightCode(source, content.language, {
            theme,
            diff: content.diffTone,
          }).join("\n");
    return `<pre class="tool-tree-content"><code${language}>${styledHtml(highlighted)}</code></pre>${notice}`;
  }
  if (content.format === "markdown") {
    const markdown = new Markdown(source, 0, 0, getMarkdownTheme());
    return `<pre class="tool-tree-content markdown">${styledHtml(markdown.render(120).join("\n"))}</pre>${notice}`;
  }
  return `<pre class="tool-tree-content">${styledHtml(content.text)}</pre>${notice}`;
}

export function renderToolTreeHtml(
  roots: readonly ToolTreeNode[],
  theme?: Theme,
): string {
  const parts = [treeStyles(theme), '<div class="cpi-tool-tree tool-tree">'];
  const seen = new Set<string>();
  const stack = roots
    .slice(0, 2001)
    .reverse()
    .map((node) => ({ node, depth: 0, close: false }));
  let count = 0;
  let bytes = 0;
  while (stack.length) {
    const item = stack.pop()!;
    if (item.close) {
      parts.push("</details>");
      continue;
    }
    if (
      ++count > 2000 ||
      item.depth > 48 ||
      bytes > 10_000_000 ||
      seen.has(item.node.id)
    ) {
      parts.push(
        "<p>Invalid tree or export display limit; some details are unavailable.</p>",
      );
      while (stack.length) if (stack.pop()!.close) parts.push("</details>");
      break;
    }
    const node = item.node;
    seen.add(node.id);
    const metadata =
      node.metadata
        ?.slice(0, 128)
        .map((text) => styledHtml(text))
        .join(" · ") ?? "";
    const status = node.status
      ? `<span class="tool-tree-status" data-status="${escapeHtml(node.status)}">${escapeHtml(node.status)}</span> `
      : "";
    const summary = node.summary
      ? ` <span class="tool-tree-summary">${styledHtml(node.summary)}</span>`
      : "";
    const background =
      node.surface &&
      ["toolPendingBg", "toolSuccessBg", "toolErrorBg"].includes(
        node.surface.background,
      )
        ? ` data-background="${node.surface.background}"${node.surface.frame ? ' data-frame="true"' : ""}`
        : "";
    const header = `<details class="tool-tree-node" data-node-id="${escapeHtml(node.id)}"${background}${node.defaultOpen ? " open" : ""}><summary>${status}<span class="tool-tree-label">${styledHtml(node.label)}</span>${summary}${metadata ? ` <span class="tool-tree-metadata">${metadata}</span>` : ""}</summary>`;
    const body = node.content ? contentHtml(node.content, theme) : "";
    if (bytes + header.length + body.length > 10_000_000) {
      parts.push(
        "<p>Export display limit; further details are unavailable.</p>",
      );
      while (stack.length) if (stack.pop()!.close) parts.push("</details>");
      break;
    }
    parts.push(header, body);
    bytes += header.length + body.length;
    stack.push({ ...item, close: true });
    const remaining = Math.max(0, 4000 - stack.length);
    for (const child of (node.children ?? []).slice(0, remaining).reverse())
      stack.push({ node: child, depth: item.depth + 1, close: false });
    if ((node.children?.length ?? 0) > remaining)
      parts.push(
        "<p>Export display limit; some child rows are unavailable.</p>",
      );
  }
  parts.push("</div>");
  return parts.join("");
}
