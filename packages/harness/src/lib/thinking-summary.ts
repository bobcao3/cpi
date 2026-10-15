import type { ThinkingRenderer } from "@earendil-works/pi-coding-agent";
import { Marked } from "@earendil-works/pi-tui";
import {
  ThinkingSummaryTree,
  type ThinkingSection,
} from "./thinking-summary-tree.ts";
import { uses_thinking_summary } from "./thinking-summary-providers.ts";

const parser = new Marked();

function parse_sections(
  blocks: readonly string[],
  streaming: boolean,
): ThinkingSection[] {
  const sections: ThinkingSection[] = [];
  let current: ThinkingSection | undefined;
  const tokens = parser.lexer(blocks.join("\n\n"));
  for (const [token_index, token] of tokens.entries()) {
    if (token.type === "heading" && token.text.trim()) {
      current = { title: token.text.trim(), summary: "" };
      sections.push(current);
      continue;
    }
    const parts =
      token.type === "paragraph" ? token.raw.split(/(?<=\n)/) : [token.raw];
    for (const [part_index, part] of parts.entries()) {
      const bold =
        token.type === "paragraph"
          ? /^(?:\*\*((?:(?!\*\*)[^\n])+)\*\*|__((?:(?!__)[^\n])+)__)[ \t]*\r?\n?$/.exec(
              part,
            )
          : null;
      const pending =
        streaming &&
        token_index === tokens.length - 1 &&
        part_index === parts.length - 1 &&
        token.type === "paragraph"
          ? /^(?:\*\*([^*\n]+)\*?|__([^_\n]+)_?)$/.exec(part)
          : null;
      const title = bold?.[1] ?? bold?.[2] ?? pending?.[1] ?? pending?.[2];
      if (title !== undefined) {
        current = { title: title.trim(), summary: "" };
        sections.push(current);
      } else if (part.trim() || current) {
        if (!current) {
          current = { title: "Summary", summary: "" };
          sections.push(current);
        }
        current.summary += part;
      }
    }
  }
  return sections;
}

export const render_thinking_summary: ThinkingRenderer = (
  blocks,
  options,
  theme,
) => {
  if (!uses_thinking_summary(options.message)) return undefined;
  const sections = parse_sections(blocks, options.isStreaming);
  const presentation = (options.state.thinking_presentation ??=
    new ThinkingSummaryTree(sections, options, theme)) as ThinkingSummaryTree;
  presentation.update(sections, options, theme);
  return presentation.tree;
};
