import type { Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  dispatchMouseEvent,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";

export type ToolRenderContext<State = any> = Omit<
  Parameters<NonNullable<ToolDefinition["renderCall"]>>[2],
  "state"
> & { state: State };
export interface LineGroup {
  head: string;
  entries: string[];
  desc?: string;
}
export type ToolBlock = LineGroup | { component: Component };

function wrap_line(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const indent = (line.match(/^ */)?.[0] ?? "").slice(
    0,
    Math.max(0, width - 1),
  );
  const rest = line.trimStart();
  const hanging = (
    indent + (stripTerminalSequences(rest).startsWith("└ ") ? "  " : "")
  ).slice(0, Math.max(0, width - 1));
  return wrapTextWithAnsi(rest, Math.max(1, width - hanging.length))
    .filter((chunk) => visibleWidth(chunk))
    .map((chunk, index) =>
      truncateToWidth((index === 0 ? indent : hanging) + chunk, width, ""),
    );
}

function render_group(block: LineGroup, width: number, theme: Theme): string[] {
  const lines: string[] = [];
  const indent = " ".repeat(visibleWidth(block.head));
  let line = block.head;
  let used = visibleWidth(block.head);
  block.entries.forEach((entry, index) => {
    const separator = index ? ", " : "";
    const size = visibleWidth(separator + entry);
    if (index && used + size > width) {
      lines.push(line);
      line = indent + entry;
      used = visibleWidth(line);
    } else {
      line += separator + entry;
      used += size;
    }
  });
  lines.push(line);
  if (block.desc) {
    const inline = ` ${theme.fg("dim", block.desc)}`;
    if (visibleWidth(line) + visibleWidth(inline) <= width)
      lines[lines.length - 1] += inline;
    else lines.push(indent + theme.fg("dim", `└ ${block.desc}`));
  }
  return lines.flatMap((line) => wrap_line(line, width));
}

export function record_block<Record>(
  records: () => readonly Record[],
  format: (records: readonly Record[]) => ToolBlock[],
  theme: Theme,
): Component {
  let blocks: ToolBlock[] = [];
  let regions: { component: Component; start: number; height: number }[] = [];
  return {
    handleMouse(event) {
      const region = regions.find(
        ({ start, height }) => event.y >= start && event.y < start + height,
      );
      return region
        ? dispatchMouseEvent(region.component, {
            ...event,
            y: event.y - region.start,
            height: region.height,
          })
        : undefined;
    },
    invalidate() {
      for (const block of blocks)
        if ("component" in block) block.component.invalidate();
    },
    render(width: number): string[] {
      regions = [];
      if (width <= 0) return [];
      blocks = format(records());
      let start = 0;
      return blocks.flatMap((block) => {
        const lines =
          "component" in block
            ? block.component
                .render(width)
                .map((line) =>
                  visibleWidth(line) > width
                    ? truncateToWidth(line, width, "")
                    : line,
                )
            : render_group(block, width, theme);
        if ("component" in block)
          regions.push({
            component: block.component,
            start,
            height: lines.length,
          });
        start += lines.length;
        return lines;
      });
    },
  };
}

export function with_record_renderers<
  Tool extends ToolDefinition<any, any, any>,
>(tool: Tool): Tool {
  const render_call = tool.renderCall;
  const render_result = tool.renderResult;
  return {
    ...tool,
    ...(render_call
      ? {
          renderCall(args: any, theme: Theme, context: ToolRenderContext) {
            const previous = context.lastComponent as
              | (Component & { source_component?: Component })
              | undefined;
            const component = render_call(args, theme, {
              ...context,
              lastComponent: previous?.source_component ?? previous,
            });
            return Object.assign(
              record_block(
                () => [args],
                () => [{ component }],
                theme,
              ),
              { source_component: component },
            );
          },
        }
      : {}),
    ...(render_result
      ? {
          renderResult(
            result: any,
            options: any,
            theme: Theme,
            context: ToolRenderContext,
          ) {
            const previous = context.lastComponent as
              | (Component & { source_component?: Component })
              | undefined;
            const component = render_result(result, options, theme, {
              ...context,
              lastComponent: previous?.source_component ?? previous,
            });
            return Object.assign(
              record_block(
                () => [result],
                () => [{ component }],
                theme,
              ),
              { source_component: component },
            );
          },
        }
      : {}),
  };
}
