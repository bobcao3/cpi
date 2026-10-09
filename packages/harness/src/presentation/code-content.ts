import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ToolTreeContent } from "../tree/index.ts";
import { VisualLinePreview } from "../tree/visual-line-preview.ts";
import { sanitizeActivityText } from "../lib/activity.ts";
import { ansiToHtml } from "./ansi-to-html.ts";

const MAX_CODE_CHARS = 200_000;
const MAX_CODE_LINES = 10_000;

export function numbered_code_content(
  source: string,
  theme: Theme,
  language?: string,
  options: {
    foreground?: "text" | "muted";
    gutter?: "dim" | "muted";
    maxVisualLines?: number;
  } = {},
): ToolTreeContent {
  const clean = sanitizeActivityText(source.slice(0, MAX_CODE_CHARS)).replace(
    /\t/g,
    "   ",
  );
  const lines = clean ? clean.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  const limited =
    source.length > MAX_CODE_CHARS || lines.length > MAX_CODE_LINES;
  lines.length = Math.min(lines.length, MAX_CODE_LINES);
  const digits = String(lines.length).length;
  const gutter = (index: number) => `${String(index + 1).padStart(digits)} │ `;
  const foreground = options.foreground ?? "text";
  const reset = theme.getFgAnsi(foreground);
  const highlighted = language
    ? highlightCode(lines.join("\n"), language, { theme })
    : lines;
  let text = lines.map((line, index) => gutter(index) + line).join("\n");
  let styled = highlighted
    .slice(0, lines.length)
    .map(
      (line, index) =>
        theme.fg(options.gutter ?? "muted", gutter(index)) +
        theme.fg(foreground, line.replace(/\x1b\[39m/g, reset)),
    )
    .join("\n");
  if (limited) {
    const notice = "… (code display limited)";
    text += `\n${notice}`;
    styled += `\n${theme.fg("muted", notice)}`;
  }
  const code_class = language
    ? ` class="language-${ansiToHtml(language)}"`
    : "";
  return {
    text,
    format: "code",
    language,
    component:
      options.maxVisualLines === undefined
        ? new Text(styled, 0, 0)
        : new VisualLinePreview({
            text: styled,
            maxVisualLines: options.maxVisualLines,
            keep: "start",
            formatHint: (hidden) =>
              theme.fg(
                "muted",
                `… (${hidden} hidden lines; open Full content)`,
              ),
          }),
    renderHtml: () =>
      `<pre class="tool-tree-content"><code${code_class}>${ansiToHtml(styled)}</code></pre>`,
  };
}
