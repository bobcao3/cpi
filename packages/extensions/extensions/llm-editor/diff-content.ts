import { type ToolTreeContent } from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import { collapseRemovals, type DiffOp } from "./diff.ts";

function diffText(ops: readonly DiffOp[], theme?: Theme): string {
  const numbers = ops
    .flatMap((op) => (op.type === "skip" ? [] : [op.old, op.new]))
    .filter((n): n is number => n !== null);
  const width = Math.max(1, ...numbers.map((n) => String(n).length));
  const pad = (n: number | null) =>
    n === null ? " ".repeat(width) : String(n).padStart(width);
  return ops
    .map((op) => {
      if (op.type === "skip") return theme ? theme.fg("dim", "…") : "…";
      const marker = op.type === "add" ? "+" : op.type === "remove" ? "-" : " ";
      const prefix = `${marker}${pad(op.old)}  ${pad(op.new)}  `;
      const text = sanitizeActivityText(op.text);
      if (!theme) return prefix + text;
      const color =
        op.type === "add"
          ? "toolDiffAdded"
          : op.type === "remove"
            ? "toolDiffRemoved"
            : "dim";
      const styledPrefix = `\x1b[2m${theme.fg(color, prefix)}\x1b[22m`;
      return (
        styledPrefix + theme.fg(op.type === "context" ? "text" : color, text)
      );
    })
    .join("\n");
}

export function diffContent(ops: DiffOp[], theme: Theme): ToolTreeContent {
  const preview = collapseRemovals(ops);
  return {
    text: diffText(ops),
    format: "diff",
    component: {
      invalidate() {},
      render(width: number): string[] {
        return diffText(preview, theme)
          .split("\n")
          .map((line) =>
            truncateToWidth(line.replace(/\t/g, "   "), width, "…"),
          );
      },
    },
  };
}
