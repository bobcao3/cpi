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
import { record_block } from "../lib/tool-block.ts";
import {
  stream_tail,
  type WriteDetails,
  type WriteMember,
} from "./write-record.ts";

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
}

/** Neutral surface: full-width background, head flush left, body inset one column. */
function editorView(
  theme: any,
  build: (bodyWidth: number) => EditorPanel[],
): Component {
  return {
    invalidate() {},
    render(width: number): string[] {
      const box = new Box(0, 0, (text: string) =>
        theme.bg("toolPendingBg", text),
      );
      for (const panel of build(Math.max(1, width - 2))) {
        box.addChild(truncView([panel.head]));
        if (panel.body?.length) {
          const bodyBox = new Box(1, 0);
          bodyBox.addChild(truncView(panel.body));
          box.addChild(bodyBox);
        }
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

interface WriteAction {
  command: string;
  details: WriteDetails;
  status: "pending" | "success" | "error";
  stream?: string[];
  reason?: string;
  limited?: boolean;
}

const ACTION_STYLE = {
  pending: ["warning", "⏳ "],
  success: ["success", " ✓ "],
  error: ["error", " ✗ "],
} as const;

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

/** Row state pi shares between the call and result renderers of one tool call. */
interface EditorRowState {
  /** Transcript tail the call body shows while the editor subagent streams. */
  stream?: string[];
}

function rowState(context: any): EditorRowState {
  return (context.state ??= {});
}

export function renderEditorCall(
  command: string,
  args: any,
  theme: any,
  context: any,
): Component {
  // The result owns the head line once it is in, so the call folds away.
  if (!context.isPartial) return new Container();
  const row = rowState(context);
  return write_action_component(
    () => [
      {
        command,
        id: context.toolCallId ?? "",
        path: args?.path,
        isError: false,
        stream: row.stream,
      },
    ],
    theme,
  );
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
  context: any,
): Component {
  const content = result.content?.[0];
  const fullText = content?.type === "text" ? content.text : "";

  // Running: hand the live transcript tail to the call renderer, which already
  // frames this row — a second frame here would stack a second block below it.
  if (opts.isPartial) {
    rowState(context).stream = stream_tail(fullText);
    return new Container();
  }

  return write_action_component(
    () => [
      {
        command,
        id: context.toolCallId ?? "",
        path: context.args?.path,
        result,
        isError: Boolean(result.isError || context.isError),
      },
    ],
    theme,
  );
}

function write_action_block(
  records: () => readonly WriteAction[],
  theme: any,
): Component {
  return record_block(
    records,
    (actions) => [
      {
        component: editorView(theme, (body_width) =>
          actions.map((action) => {
            const d = action.details;
            const [color, glyph] = ACTION_STYLE[action.status];
            return {
              head:
                theme.fg(color, `${glyph}${action.command}: `) +
                fileLabel(d.path, theme) +
                theme.fg(
                  action.status === "error" ? "error" : "dim",
                  action_summary(action),
                ),
              body:
                action.status === "pending"
                  ? action.stream?.map((line) => gray(theme, line))
                  : [
                      ...renderDiffOps(d.diffOps ?? [], theme)
                        .split("\n")
                        .filter(Boolean),
                      ...(action.reason
                        ? wrapReason(action.reason, body_width, theme)
                        : []),
                      ...(action.limited
                        ? [
                            gray(
                              theme,
                              "  └ Nested rendering metadata was truncated",
                            ),
                          ]
                        : []),
                    ],
            };
          }),
        ),
      },
    ],
    theme,
  );
}

function action_summary(action: WriteAction): string {
  if (action.status === "pending") return "";
  const d = action.details;
  if (action.status === "error" && !d.failure) return " failed";
  if (d.failure || d.kind === "edit") {
    const suffix =
      action.status === "error"
        ? " before failure"
        : d.rewrite
          ? ", whole-file rewrite"
          : "";
    return ` · applied ${d.hunks} hunk${d.hunks === 1 ? "" : "s"}${suffix}`;
  }
  return d.kind === "create" ? ` · created ${d.bytes} bytes` : "";
}

export function write_action_component(
  records: () => readonly WriteMember[],
  theme: any,
): Component {
  return write_action_block(
    () =>
      records().map((member) => {
        const details = {
          ...member.result?.details,
          path: member.result?.details?.path ?? member.path,
        };
        const failed = Boolean(
          member.isError || details.kind === "error" || details.failure,
        );
        const text =
          member.result?.content?.find((part) => part.type === "text")?.text ??
          "";
        return {
          command: member.command,
          details,
          status: member.result ? (failed ? "error" : "success") : "pending",
          stream: member.stream,
          limited: member.limited,
          reason: failed
            ? oneLine(details.message ?? text) || "failed"
            : undefined,
        };
      }),
    theme,
  );
}
