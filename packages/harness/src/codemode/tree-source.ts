import { type ToolTreeNode } from "../tree/index.ts";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { numbered_code_content } from "../presentation/code-content.ts";

const MAX_CODE_CHARS = 65536;
const MAX_CODE_LINES = 2048;
const PREVIEW_LINES = 3;

export function script_node(
  id: string,
  code: string,
  theme: Theme,
): ToolTreeNode {
  const source = stripTerminalSequences(code)
    .replace(/\r/g, "")
    .replace(/\t/g, "  ");
  const lines = source
    .slice(0, MAX_CODE_CHARS)
    .trimEnd()
    .split("\n")
    .slice(0, MAX_CODE_LINES);
  const limited =
    source.length > MAX_CODE_CHARS ||
    source.split("\n").length > MAX_CODE_LINES;
  return {
    id: `${id}/script`,
    label: "Script",
    summary: `JavaScript · ${code ? code.trimEnd().split("\n").length : 0} lines`,
    defaultOpen: true,
    ...(code
      ? {
          content: numbered_code_content(
            lines.join("\n"),
            theme,
            "javascript",
            { foreground: "muted", gutter: "dim" },
          ),
          contentPreview: numbered_code_content(
            lines.slice(0, PREVIEW_LINES).join("\n"),
            theme,
            "javascript",
            { foreground: "muted", gutter: "dim", wrap: false },
          ),
        }
      : {}),
    children: [
      ...(limited
        ? [{ id: `${id}/script/limit`, label: "Code display limited" }]
        : []),
    ],
  };
}
