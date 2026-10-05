import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { ToolRenderContext } from "../lib/tool-block.ts";
import type { CodeState } from "./calls.ts";

const MAX_CHARS = 65536;
const MAX_ROWS = 256;

export function stdout_component(
  output: string,
  theme: Theme,
  context: ToolRenderContext<CodeState>,
): Component {
  const state = (context.state.stdout ??= {
    expanded: context.expanded,
    open: context.expanded,
  });
  if (state.expanded !== context.expanded) {
    state.expanded = context.expanded;
    state.open = context.expanded;
  }
  const text = stripTerminalSequences(output.slice(0, MAX_CHARS))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  const source = text.split("\n");
  const prefix = context.isError ? theme.fg("error", "✗ ") : "  ";
  return {
    invalidate() {},
    handleMouse(event) {
      if (event.type !== "click" || event.button !== "left") return undefined;
      if (event.y !== 0 || event.x !== 2)
        return { handled: true, render: false };
      state.open = !state.open;
      context.invalidate();
      return { handled: true };
    },
    render(width) {
      if (width <= 0) return [];
      const title =
        prefix +
        theme.fg("dim", state.open ? "▾ " : "▸ ") +
        theme.fg("toolTitle", "output");
      const preview = state.open
        ? ""
        : theme.style(
            ` ${source[0]}${source.length > 1 || output.length > MAX_CHARS ? " …" : ""}`,
            { fg: "toolOutput", dim: true },
          );
      const rows = [truncateToWidth(title + preview, width, "…")];
      if (!state.open) return rows;
      const limit = truncateToWidth(
        theme.fg("dim", "  │ … display limit"),
        width,
        "",
      );
      if (width <= 4) return [...rows, limit];
      const guide = theme.fg("dim", "  │ ");
      for (const line of source) {
        for (const chunk of wrapTextWithAnsi(line, width - 4)) {
          if (rows.length >= MAX_ROWS) return [...rows, limit];
          rows.push(
            truncateToWidth(
              guide + theme.style(chunk, { fg: "toolOutput", dim: true }),
              width,
              "",
            ),
          );
        }
      }
      if (output.length > MAX_CHARS) rows.push(limit);
      return rows;
    },
  };
}
