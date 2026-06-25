/**
 * TUI rendering for the `view` / `edit` / `create` tools — three stages under a
 * persistent `{command} : {file}` header (mirrors shell.ts w/ Ctrl+O expansion):
 *   1. preparation (args streaming, not yet executing): instruction/query/
 *      file_text tail (3 lines).
 *   2. subagent running: live transcript tail (5 lines, gray) + ⏳ running.
 *   3. done: rendered result — edit uses pi's `renderDiff` (colored, max 16),
 *      view/tree/content in toolOutput, image via pi's image pipeline (or a
 *      terminal-cap fallback), create/error as status.
 * Each body is followed by a gray "Ctrl+O to expand/collapse" hint. Once
 * executing, renderCall shows the header only (body owned by renderResult).
 *
 * Every line is horizontally truncated to the render width (via pi-tui's
 * ANSI-aware `truncateToWidth`) — never wrapped/folded. pi-tui `Text` wraps,
 * so we return a truncating Component (`truncView`) from all paths instead.
 *
 * The live transcript is the subagent's stderr (the subagent-transcript ext,
 * loaded via `-e`), relayed through `onUpdate` partial results.
 */

import { truncateToWidth, getCapabilities, getImageDimensions, imageFallback } from "@earendil-works/pi-tui";
import type { DiffOp } from "./diff.ts";

const CALL_TAIL = 3;
const STREAM_TAIL = 5;
const RESULT_MAX = 16;
/** Partial-update throttle for the streaming transcript (ms). */
export const STREAM_UPDATE_MS = 200;

const truncateLine = (line: string, width: number) =>
  truncateToWidth(line.replace(/\t/g, "   "), width, "…").replace("\x1b[0m…", "…");

interface TruncView {
  invalidate(): void;
  render(width: number): string[];
}

/** View that truncates each line to the render width (no wrapping). */
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
  kind?: "edit" | "view" | "create" | "tree" | "content" | "image" | "video" | "error";
  diff?: string;
  diffOps?: DiffOp[];
  text?: string;
  note?: string;
  blocks?: number;
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
  return ops
    .map((op) => {
      switch (op.type) {
        case "skip":
          return gray(theme, "…");
        case "add":
          return (
            theme.fg("toolDiffAdded", "+") +
            gray(theme, op.lineNum) +
            theme.fg("toolDiffAdded", " " + op.text)
          );
        case "remove":
          return (
            theme.fg("toolDiffRemoved", "-") +
            gray(theme, op.lineNum) +
            theme.fg("toolDiffRemoved", " " + op.text)
          );
        case "context":
          return gray(theme, " " + op.lineNum) + theme.fg("text", " " + op.text);
      }
    })
    .join("\n");
}

/**
 * Image result: the text note always; when the terminal can't (or the user
 * chose not to) render inline images, append a per-image fallback marker.
 * Mirrors read-media's renderMediaResult (now merged here). Returns lines.
 */
function renderImageLines(result: any, showImages: boolean): string[] {
  const content = result?.content ?? [];
  const textBlocks = content.filter((c: any) => c.type === "text");
  const imageBlocks = content.filter((c: any) => c.type === "image");
  let output = textBlocks.map((c: any) => c.text ?? "").join("\n");
  const caps = getCapabilities();
  if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
    const indicators = imageBlocks
      .map((img: any) => {
        const dims = img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
        return imageFallback(img.mimeType ?? "image/unknown", dims);
      })
      .join("\n");
    output = output ? `${output}\n${indicators}` : indicators;
  }
  return output ? output.split("\n") : [];
}

export function renderEditorCall(command: string, args: any, theme: any, context: any): TruncView {
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
  const more = lines.length > CALL_TAIL ? [gray(theme, `… ${lines.length - CALL_TAIL} more`)] : [];
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

  // Stage 2: subagent running — live transcript tail (gray).
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

  // Stage 3: done — rendered result (edit → renderDiff colored).
  const d = (result.details ?? {}) as EditorDetails;
  const isError = result.isError || d.kind === "error";
  let status = isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
  if (!isError) {
    if (d.kind === "edit")
      status += gray(
        theme,
        ` · edited ${d.blocks} block${d.blocks !== 1 ? "s" : ""}${d.rewrite ? ", whole-file rewrite" : ""}`,
      );
    else if (d.kind === "create") status += gray(theme, ` · created ${d.bytes} bytes`);
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
    if (expanded) return truncView([...lines, status + " " + hint(theme, expanded)]);
    const shown = lines.length <= RESULT_MAX ? lines : lines.slice(-RESULT_MAX);
    const range = lines.length > RESULT_MAX ? gray(theme, ` · L${lines.length - RESULT_MAX + 1}-${lines.length}`) + " " : "";
    return truncView([...shown, status + range + hint(theme, expanded)]);
  } else if ((d.kind === "view" || d.kind === "tree" || d.kind === "content" || d.kind === "video") && (d.text ?? d.note) != null) {
    body = (d.text ?? d.note ?? "").trimEnd();
  }

  const lines = body ? body.split("\n").filter((l: string) => l !== "") : [];
  const total = lines.length;
  const colorLine = (l: string) => (colored ? l : theme.fg("toolOutput", l));

  if (total === 0) return truncView([status]);
  if (expanded) {
    return truncView([...lines.map(colorLine), status + " " + hint(theme, expanded)]);
  }
  const shown = total <= RESULT_MAX ? lines : lines.slice(-RESULT_MAX);
  const range =
    total > RESULT_MAX ? gray(theme, ` · L${total - RESULT_MAX + 1}-${total}`) + " " : "";
  return truncView([...shown.map(colorLine), status + range + hint(theme, expanded)]);
}
