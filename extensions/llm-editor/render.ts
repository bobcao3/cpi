/**
 * TUI rendering for `edit`/`write`/`apply_patch`: a leading
 * `<glyph> {command}: {file}` line carries running/success/failure state, the
 * edit diff follows (old/new line-number columns, long deletion runs elided per
 * diff.collapseRemovals), and a failure appends an indented `└` reason. The
 * surface keeps a neutral background; red text marks errors.
 */

import {
  Box,
  Container,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { collapseRemovals, type DiffOp } from "./diff.ts";
import { fileLabel, oneLine } from "./read-batch.ts";

const STREAM_TAIL = 5;
/** Partial-update throttle for the streaming transcript (ms). */
export const STREAM_UPDATE_MS = 200;

const truncateLine = (line: string, width: number) =>
  truncateToWidth(line.replace(/\t/g, "   "), width, "…").replace(
    "\x1b[0m…",
    "…",
  );

interface TruncView {
  invalidate(): void;
  render(width: number): string[];
}

function truncView(lines: string[]): TruncView {
  return {
    invalidate() {},
    render(width: number): string[] {
      return lines.map((l) => truncateLine(l, width));
    },
  };
}

interface EditorPanel {
  head: string;
  body?: string[];
  headLast?: boolean;
}

/** Neutral surface: full-width background, head flush left, body inset one column. */
function editorView(
  theme: any,
  build: (bodyWidth: number) => EditorPanel,
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      const box = new Box(0, 0, (text: string) =>
        theme.bg("toolPendingBg", text),
      );
      const panel = build(Math.max(1, width - 2));
      const head = truncView([panel.head]);
      const body = panel.body ?? [];
      if (body.length === 0) {
        box.addChild(head);
      } else {
        const bodyBox = new Box(1, 0);
        bodyBox.addChild(truncView(body));
        for (const child of panel.headLast ? [bodyBox, head] : [head, bodyBox])
          box.addChild(child);
      }
      const lines = box.render(width);
      const bgAnsi = theme.getBgAnsi("toolPendingBg");
      if (!bgAnsi.startsWith("\x1b[48;")) return lines;
      const fg = bgAnsi.replace("48;", "38;");
      const half = (glyph: string) => `${fg}${glyph.repeat(width)}\x1b[39m`;
      return [half("▄"), ...lines, half("▀")];
    },
  };
}

interface EditorDetails {
  kind?: "edit" | "create" | "error";
  path?: string;
  diffOps?: DiffOp[];
  hunks?: number;
  rewrite?: boolean;
  bytes?: number;
  message?: string;
}

const HEAD_PENDING = "⏳ ";
const HEAD_OK = " ✓ ";
const HEAD_FAIL = " ✗ ";

function gray(theme: any, t: string): string {
  return theme.fg("dim", t);
}

/** Wrap colored text in ANSI faint styling. */
function faint(theme: any, color: string, text: string): string {
  return `\x1b[2m${theme.fg(color, text)}\x1b[22m`;
}

function renderDiffOps(ops: DiffOp[], theme: any): string {
  const shown = collapseRemovals(ops);
  const numbers = shown
    .filter((op) => op.type !== "skip")
    .flatMap((op) =>
      op.type === "add"
        ? [op.new]
        : op.type === "remove"
          ? [op.old]
          : [op.old, op.new],
    )
    .filter((n): n is number => n != null);
  const width = Math.max(1, ...numbers.map((n) => String(n).length));
  const pad = (n: number | null) =>
    n == null ? " ".repeat(width) : String(n).padStart(width);
  const sep = "  ";
  return shown
    .map((op) => {
      switch (op.type) {
        case "skip":
          return gray(theme, "…");
        case "add":
          return (
            faint(
              theme,
              "toolDiffAdded",
              "+" + pad(null) + sep + pad(op.new) + sep,
            ) + theme.fg("toolDiffAdded", op.text)
          );
        case "remove":
          return (
            faint(
              theme,
              "toolDiffRemoved",
              "-" + pad(op.old) + sep + pad(null) + sep,
            ) + theme.fg("toolDiffRemoved", op.text)
          );
        case "context":
          return (
            gray(theme, " " + pad(op.old) + sep + pad(op.new) + sep) +
            theme.fg("text", op.text)
          );
      }
    })
    .join("\n");
}

export function renderEditorCall(
  command: string,
  args: any,
  theme: any,
  context: any,
): Component {
  // The result owns the head line once it is in, so the call folds away.
  if (!context.isPartial) return new Container();
  return editorView(theme, () => ({
    head:
      theme.fg("warning", `${HEAD_PENDING}${command}: `) +
      fileLabel(args?.path, theme),
  }));
}

function wrapReason(reason: string, width: number, theme: any): string[] {
  const prefix = "  └ ";
  const hanging = " ".repeat(visibleWidth(prefix));
  const room = Math.max(1, width - hanging.length);
  return wrapTextWithAnsi(reason, room).map((line, index) =>
    theme.fg("error", (index ? hanging : prefix) + line),
  );
}

export function renderEditorResult(
  command: string,
  result: any,
  opts: { isPartial: boolean },
  theme: any,
): Component {
  const content = result.content?.[0];
  const fullText = content?.type === "text" ? content.text : "";

  // Running: live subagent transcript tail (gray).
  if (opts.isPartial) {
    const lines = fullText
      .trimEnd()
      .split("\n")
      .filter((l: string) => l !== "" && !/^(jsonl:|summary:)/.test(l));
    const tail = lines.slice(-STREAM_TAIL);
    const hidden = lines.length - tail.length;
    const status =
      theme.fg("warning", "⏳ running") +
      (hidden > 0
        ? gray(theme, ` · L${hidden + 1}-${lines.length}`)
        : gray(theme, ` · ${lines.length} lines`));
    return editorView(theme, () => ({
      head: status,
      body: tail.map((l: string) => gray(theme, l)),
      headLast: true,
    }));
  }

  const d = (result.details ?? {}) as EditorDetails;
  const file = fileLabel(d.path, theme);
  if (result.isError || d.kind === "error") {
    const reason = oneLine(d.message ?? fullText) || "failed";
    const head =
      theme.fg("error", `${HEAD_FAIL}${command}: `) +
      file +
      theme.fg("error", " failed");
    return editorView(theme, (bodyWidth) => ({
      head,
      body: wrapReason(reason, bodyWidth, theme),
    }));
  }

  const head =
    theme.fg("success", `${HEAD_OK}${command}: `) +
    file +
    (d.kind === "edit"
      ? gray(
          theme,
          ` · applied ${d.hunks} hunk${d.hunks !== 1 ? "s" : ""}${d.rewrite ? ", whole-file rewrite" : ""}`,
        )
      : d.kind === "create"
        ? gray(theme, ` · created ${d.bytes} bytes`)
        : "");
  const body = d.kind === "edit" ? renderDiffOps(d.diffOps ?? [], theme) : "";
  const lines = body ? body.split("\n").filter((l: string) => l !== "") : [];
  return editorView(theme, () => ({ head, body: lines }));
}
