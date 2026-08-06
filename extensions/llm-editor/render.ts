/**
 * TUI rendering for `view`/`edit`/`create` under a persistent `{cmd} : {file}`
 * header — args tail while preparing, live transcript tail while running (the
 * subagent's stderr relayed via onUpdate), then the result: edit diffs as
 * old/new line-number columns, others capped at 16 lines (Ctrl+O expands).
 * Every line is ANSI-aware truncated to the render width, never wrapped.
 */

import {
  truncateToWidth,
  getCapabilities,
  getImageDimensions,
  imageFallback,
} from "@earendil-works/pi-tui";
import type { DiffOp } from "./diff.ts";

const CALL_TAIL = 3;
const STREAM_TAIL = 5;
const RESULT_MAX = 16;
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

interface EditorDetails {
  id?: string;
  kind?:
    | "edit"
    | "view"
    | "create"
    | "tree"
    | "content"
    | "image"
    | "video"
    | "error";
  diff?: string;
  diffOps?: DiffOp[];
  text?: string;
  note?: string;
  hunks?: number;
  rewrite?: boolean;
  bytes?: number;
  message?: string;
}

function callBody(args: any): string {
  return args.instruction ?? args.query ?? args.file_text ?? "";
}

function headerLine(command: string, args: any, theme: any): string {
  return (
    theme.fg("toolTitle", theme.bold(command)) +
    theme.fg("toolTitle", ` : ${args.path}`)
  );
}

function gray(theme: any, t: string): string {
  return theme.fg("dim", t);
}

function hint(theme: any, expanded: boolean): string {
  return gray(theme, expanded ? "Ctrl+O to collapse" : "Ctrl+O to expand");
}

function renderDiffOps(ops: DiffOp[], theme: any): string {
  const numbers = ops
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
  return ops
    .map((op) => {
      switch (op.type) {
        case "skip":
          return gray(theme, "…");
        case "add":
          return (
            theme.fg("toolDiffAdded", "+") +
            gray(theme, pad(null) + sep + pad(op.new) + sep) +
            theme.fg("toolDiffAdded", op.text)
          );
        case "remove":
          return (
            theme.fg("toolDiffRemoved", "-") +
            gray(theme, pad(op.old) + sep + pad(null) + sep) +
            theme.fg("toolDiffRemoved", op.text)
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

function renderImageLines(result: any, showImages: boolean): string[] {
  const content = result?.content ?? [];
  const textBlocks = content.filter((c: any) => c.type === "text");
  const imageBlocks = content.filter((c: any) => c.type === "image");
  let output = textBlocks.map((c: any) => c.text ?? "").join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const indicators = imageBlocks
      .map((img: any) => {
        const dims =
          img.data && img.mimeType
            ? (getImageDimensions(img.data, img.mimeType) ?? undefined)
            : undefined;
        return imageFallback(img.mimeType ?? "image/unknown", dims);
      })
      .join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  return output ? output.split("\n") : [];
}

export function renderEditorCall(
  command: string,
  args: any,
  theme: any,
  context: any,
): TruncView {
  const head = headerLine(command, args, theme);
  // Executing: body (transcript/diff) is owned by renderResult — header only.
  if (context.executionStarted) return truncView([head]);
  const body = callBody(args);
  if (!body) return truncView([head]);
  const lines = body.split("\n");
  if (context.expanded) {
    return truncView([
      head,
      ...lines.map((l: string) => theme.fg("toolTitle", l)),
      hint(theme, true),
    ]);
  }
  const tail = lines.slice(-CALL_TAIL);
  const more =
    lines.length > CALL_TAIL
      ? [gray(theme, `… ${lines.length - CALL_TAIL} more`)]
      : [];
  return truncView([
    head,
    ...more,
    ...tail.map((l: string) => theme.fg("toolTitle", l)),
    hint(theme, false),
  ]);
}

export function renderEditorResult(
  result: any,
  opts: { expanded: boolean; isPartial: boolean },
  theme: any,
  context?: any,
): TruncView {
  const { expanded } = opts;
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
        : gray(theme, ` · ${lines.length} lines`)) +
      " " +
      hint(theme, expanded);
    const shown = expanded ? lines : tail;
    return truncView([...shown.map((l: string) => gray(theme, l)), status]);
  }

  // Done: render the result (edit → colored diff).
  const d = (result.details ?? {}) as EditorDetails;
  const isError = result.isError || d.kind === "error";
  let status = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  if (!isError) {
    if (d.kind === "edit")
      status += gray(
        theme,
        ` · applied ${d.hunks} hunk${d.hunks !== 1 ? "s" : ""}${d.rewrite ? ", whole-file rewrite" : ""}`,
      );
    else if (d.kind === "create")
      status += gray(theme, ` · created ${d.bytes} bytes`);
    else if (d.kind) status += gray(theme, ` · ${d.kind}`);
  }

  let body = "";
  let colored = false;
  if (isError) body = d.message ?? fullText;
  else if (d.kind === "edit") {
    body = renderDiffOps(d.diffOps ?? [], theme);
    colored = true;
  } else if (d.kind === "image") {
    const imgLines = renderImageLines(result, context?.showImages ?? false);
    const lines = imgLines.map((l: string) => theme.fg("toolOutput", l));
    if (lines.length === 0) return truncView([status]);
    if (expanded)
      return truncView([...lines, status + " " + hint(theme, expanded)]);
    const shown = lines.length <= RESULT_MAX ? lines : lines.slice(-RESULT_MAX);
    const range =
      lines.length > RESULT_MAX
        ? gray(theme, ` · L${lines.length - RESULT_MAX + 1}-${lines.length}`) +
          " "
        : "";
    return truncView([...shown, status + range + hint(theme, expanded)]);
  } else if (
    (d.kind === "view" ||
      d.kind === "tree" ||
      d.kind === "content" ||
      d.kind === "video") &&
    (d.text ?? d.note) != null
  ) {
    body = (d.text ?? d.note ?? "").trimEnd();
  }

  const lines = body ? body.split("\n").filter((l: string) => l !== "") : [];
  const total = lines.length;
  const colorLine = (l: string) => (colored ? l : theme.fg("toolOutput", l));

  if (total === 0) return truncView([status]);
  if (expanded) {
    return truncView([
      ...lines.map(colorLine),
      status + " " + hint(theme, expanded),
    ]);
  }
  const shown = total <= RESULT_MAX ? lines : lines.slice(-RESULT_MAX);
  const range =
    total > RESULT_MAX
      ? gray(theme, ` · L${total - RESULT_MAX + 1}-${total}`) + " "
      : "";
  return truncView([
    ...shown.map(colorLine),
    status + range + hint(theme, expanded),
  ]);
}
