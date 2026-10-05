import {
  ObjectTreeComponent,
  type ExtensionAPI,
  type ObjectTreeState,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  stripTerminalSequences,
  Text,
} from "@earendil-works/pi-tui";
import { record_block, type ToolBlock } from "./tool-block.ts";

interface TreeState {
  call: ObjectTreeState;
  result: ObjectTreeState;
}

function tree_renderers(label: string, mcp: boolean): ToolRenderers {
  return {
    renderShell: "self",
    renderCall(args, theme, context) {
      const state: TreeState = (context.state.cpi_tree ??= {
        call: {},
        result: {},
      });
      return new ObjectTreeComponent(
        {
          label,
          value: args,
          prefix: theme.fg(
            context.isError
              ? "error"
              : context.isPartial
                ? "warning"
                : "success",
            context.isError ? "✗ " : context.isPartial ? "⏳ " : "✓ ",
          ),
          expanded: context.expanded,
          state: state.call,
          invalidate: context.invalidate,
        },
        theme,
      );
    },
    renderResult(result, options, theme, context) {
      const state: TreeState = (context.state.cpi_tree ??= {
        call: {},
        result: {},
      });
      const output = result.content
        .flatMap((block) =>
          block.type === "text"
            ? [block.text]
            : !context.showImages || !getCapabilities().images
              ? [`[image ${block.mimeType}]`]
              : [],
        )
        .join("\n");
      const raw = result.structuredContent;
      const structured = mcp
        ? raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.getOwnPropertyDescriptor(raw, "structuredContent")?.value
          : undefined
        : raw;
      const value =
        structured === undefined
          ? output
          : output
            ? {
                result: structured,
                [context.isError ? "error" : "output"]: output,
              }
            : structured;
      const full_path: unknown =
        result.details && typeof result.details === "object"
          ? Object.getOwnPropertyDescriptor(result.details, "fullOutputPath")
              ?.value
          : undefined;
      return record_block(
        () => [value],
        () => {
          const blocks: ToolBlock[] = [];
          if (
            (state.call.open?.get("") ?? options.expanded) &&
            (output || structured !== undefined)
          ) {
            blocks.push({
              component: new ObjectTreeComponent(
                {
                  label: "result",
                  prefix: "  ",
                  value,
                  expanded: options.expanded,
                  state: state.result,
                  invalidate: context.invalidate,
                },
                theme,
              ),
            });
          }
          if (typeof full_path === "string")
            blocks.push({
              component: new Text(
                theme.fg(
                  "muted",
                  `Full output: ${stripTerminalSequences(full_path.slice(0, 8192))}`,
                ),
                0,
                0,
              ),
            });
          return blocks;
        },
        theme,
      );
    },
  };
}

export function register_tree_renderers(pi: ExtensionAPI): void {
  pi.registerToolRenderer((name, next) => {
    const existing = next();
    const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
    if (existing?.renderCall || existing?.renderResult) {
      if (!mcp) return existing;
      const source = pi.getAllTools().find((tool) => tool.name === name)
        ?.sourceInfo.path;
      if (source !== undefined && source !== "builtin:mcp") return existing;
    }
    return tree_renderers(mcp ? `${mcp[1]}/${mcp[2]}` : name, mcp !== null);
  });
}
