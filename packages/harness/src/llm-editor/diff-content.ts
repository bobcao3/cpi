import { type ToolTreeContent } from "../tree/index.ts";
import {
  getLanguageFromPath,
  renderDiff,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import { collapseRemovals, type DiffOp } from "./diff.ts";

function numberWidth(ops: readonly DiffOp[]): number {
  return ops.reduce(
    (width, op) =>
      op.type === "skip"
        ? width
        : Math.max(
            width,
            String(op.old ?? "").length,
            String(op.new ?? "").length,
          ),
    1,
  );
}

function diffText(ops: readonly DiffOp[]): string {
  const width = numberWidth(ops);
  const pad = (n: number | null) =>
    n === null ? " ".repeat(width) : String(n).padStart(width);
  return ops
    .map((op) => {
      if (op.type === "skip") return "…";
      const marker = op.type === "add" ? "+" : op.type === "remove" ? "-" : " ";
      const prefix = `${marker}${pad(op.old)}  ${pad(op.new)}  `;
      const text = sanitizeActivityText(op.text);
      return prefix + text;
    })
    .join("\n");
}

export function diffContent(
  ops: DiffOp[],
  theme: Theme,
  path?: string,
): ToolTreeContent {
  const preview = collapseRemovals(ops);
  const text = diffText(ops);
  const language = path ? getLanguageFromPath(path) : undefined;
  const diffLineNumbers = 2 * numberWidth(ops) + 5;
  const indices = new Map(ops.map((op, index) => [op, index]));
  let styled: string[] | undefined;
  return {
    text,
    format: "diff",
    language,
    diffLineNumbers,
    component: {
      invalidate() {
        styled = undefined;
      },
      render(width: number): string[] {
        styled ??= renderDiff(text, {
          theme,
          language,
          lineNumbers: diffLineNumbers,
        }).split("\n");
        return preview.map((op) => {
          const index = indices.get(op);
          const line =
            index === undefined ? theme.fg("dim", "…") : styled![index];
          return truncateToWidth(line, width, "…");
        });
      },
    },
  };
}
