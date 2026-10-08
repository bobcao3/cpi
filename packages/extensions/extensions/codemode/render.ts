import {
  formatCodemodeOutput,
  highlightCode,
  keyHint,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  getImageDimensions,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import {
  record_block,
  type ToolBlock,
  type ToolRenderContext,
} from "../lib/tool-block.ts";
import { render_calls, type CodeState } from "./calls.ts";
import type { CodeDetails, ToolRenderers } from "./preview.ts";
import { stdout_component } from "./stdout.ts";

const MAX_CODE_CHARS = 65536;
const MAX_DISPLAY_LINES = 2048;
const CODE_PREVIEW_LINES = 3;
const HEADER =
  /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;

function code_component(
  code: string,
  theme: Theme,
  context: ToolRenderContext<CodeState>,
): Component {
  const source = stripTerminalSequences(
    code.replace(/\r/g, "").replace(/\t/g, "  "),
  )
    .slice(0, MAX_CODE_CHARS)
    .trimEnd();
  const state = context.state;
  if (state.source !== source || state.theme !== theme) {
    state.source = source;
    state.theme = theme;
    state.highlighted = highlightCode(source, "javascript");
  }
  const highlighted = state.highlighted ?? [];
  return {
    invalidate() {},
    render(width: number): string[] {
      const digits = String(highlighted.length).length;
      const rows: string[] = [];
      const limit = context.expanded ? MAX_DISPLAY_LINES : CODE_PREVIEW_LINES;
      let remaining = highlighted.length;
      for (const [index, line] of highlighted.entries()) {
        if (rows.length >= limit) break;
        const gutter = `   ${String(index + 1).padStart(digits)} │ `;
        const room = Math.max(1, width - visibleWidth(gutter));
        const wrapped = wrapTextWithAnsi(line, room);
        let complete = true;
        for (const [part, chunk] of wrapped.entries()) {
          if (rows.length >= limit) {
            complete = false;
            break;
          }
          const prefix = part
            ? " ".repeat(visibleWidth(gutter))
            : theme.fg("dim", gutter);
          rows.push(truncateToWidth(prefix + chunk, width, ""));
        }
        if (complete) remaining--;
      }
      if (remaining || code.length > MAX_CODE_CHARS)
        rows.push(
          truncateToWidth(
            theme.fg(
              "muted",
              `   └ ${remaining ? `${remaining} more code lines` : "Code display limited"}${context.expanded ? " (display limit)" : ` · ${keyHint("app.tools.expand", "to expand")}`}`,
            ),
            width,
            "…",
          ),
        );
      return rows;
    },
  };
}

export function codemode_renderers(
  renderers: ToolRenderers,
): Pick<
  ToolDefinition<any, CodeDetails, CodeState>,
  "renderCall" | "renderResult" | "renderShell"
> {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const input = args as { code?: unknown };
      const code = typeof input?.code === "string" ? input.code : "";
      const lines = code ? code.trimEnd().split("\n").length : 0;
      const glyph = context.isPartial ? "⏳" : context.isError ? " ✗" : " ✓";
      const color = context.isPartial
        ? "warning"
        : context.isError
          ? "error"
          : "success";
      return record_block(
        () => [code],
        () => [
          {
            component: new Text(
              theme.fg(color, `${glyph} Code mode: `) +
                theme.fg(
                  "dim",
                  `JavaScript · ${lines} lines${context.durationMs === undefined ? "" : ` · ${(context.durationMs / 1000).toFixed(2)}s`}${context.state.cost ? ` · $${context.state.cost.toPrecision(2)}` : ""}`,
                ) +
                theme.fg(
                  "muted",
                  ` · ${keyHint("app.tools.expand", context.expanded ? "to collapse" : "to expand")}`,
                ),
              0,
              0,
            ),
          },
          { component: code_component(code, theme, context) },
        ],
        theme,
      );
    },
    renderResult(result, options, theme, context) {
      context.state.cost =
        result.details?.calls.reduce(
          (total, call) => total + (call.cost ?? 0),
          0,
        ) ?? 0;
      return record_block(
        () => [result],
        (records) => {
          const current = records[0];
          const blocks: ToolBlock[] = [
            {
              component: render_calls(
                current.details,
                theme,
                context,
                renderers,
              ),
            },
          ];
          if (options.isPartial) return blocks;
          const [first, ...rest] = current.content;
          const header =
            first?.type === "text" ? HEADER.exec(first.text) : null;
          const content = header ? rest : current.content;
          const output = content
            .flatMap((block, index) =>
              block.type === "text"
                ? [
                    formatCodemodeOutput(
                      block.text,
                      current.details?.output?.[index + (header ? 1 : 0)],
                    ),
                  ]
                : [],
            )
            .join("\n");
          if (output)
            blocks.push({
              component: stdout_component(output, theme, context),
            });
          if (current.details?.fullOutputPath)
            blocks.push({
              component: new Text(
                theme.fg(
                  "muted",
                  `   Full output: ${current.details.fullOutputPath}`,
                ),
                0,
                0,
              ),
            });
          if (current.details?.outputMetadataLimited)
            blocks.push({
              component: new Text(
                theme.fg(
                  "muted",
                  "   Output type metadata exceeded the display limit",
                ),
                0,
                0,
              ),
            });
          if (!context.showImages || !getCapabilities().images) {
            for (const image of content.filter(
              (block) => block.type === "image",
            )) {
              const dimensions = getImageDimensions(image.data, image.mimeType);
              blocks.push({
                component: new Text(
                  theme.fg(
                    "muted",
                    `   Image: ${image.mimeType}${dimensions ? ` · ${dimensions.widthPx}×${dimensions.heightPx}` : ""}`,
                  ),
                  0,
                  0,
                ),
              });
            }
          }
          return blocks;
        },
        theme,
      );
    },
  };
}
