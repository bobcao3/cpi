import { type ToolTreeContent, type ToolTreeNode } from "../tree/index.ts";
import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";

const MAX_CODE_CHARS = 65536;
const MAX_CODE_LINES = 2048;
const PREVIEW_LINES = 3;

function numbered_source(
  lines: readonly string[],
  theme: Theme,
): ToolTreeContent {
  const digits = String(lines.length).length;
  const gutter = (index: number) => `${String(index + 1).padStart(digits)} │ `;
  const number = (line: string, index: number) => `${gutter(index)}${line}`;
  return {
    text: lines.map(number).join("\n"),
    format: "code",
    language: "javascript",
    component: new Text(
      highlightCode(lines.join("\n"), "javascript")
        .map((line, index) => theme.fg("dim", gutter(index)) + line)
        .join("\n"),
      0,
      0,
    ),
  };
}

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
      ? { content: numbered_source(lines.slice(0, PREVIEW_LINES), theme) }
      : {}),
    children: [
      ...(lines.length > PREVIEW_LINES
        ? [
            {
              id: `${id}/script/full`,
              label: `${lines.length - PREVIEW_LINES} more code lines`,
              content: numbered_source(lines, theme),
            },
          ]
        : []),
      ...(limited
        ? [{ id: `${id}/script/limit`, label: "Code display limited" }]
        : []),
    ],
  };
}
