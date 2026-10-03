import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import {
  record_block,
  type ToolBlock,
  type ToolRenderContext,
} from "../lib/tool-block.ts";
import {
  groupedReadComponent,
  oneLine,
  type ReadMember,
  type ReadValue,
} from "../llm-editor/read-batch.ts";
import type { CallPreview, CodeDetails, ToolRenderers } from "./preview.ts";
import { write_action_component } from "../llm-editor/render.ts";
import {
  is_write_action,
  type WriteMember,
  type WriteDetails,
} from "../llm-editor/write-record.ts";

export interface CodeState {
  nested?: Map<string, Record<string, unknown>>;
  source?: string;
  highlighted?: string[];
  theme?: Theme;
}

function fallback_args(text: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

export function render_calls(
  details: CodeDetails | undefined,
  theme: Theme,
  context: ToolRenderContext<CodeState>,
  renderers: ToolRenderers,
): Component {
  const states = (context.state.nested ??= new Map());
  const calls = details?.calls ?? [];
  const shown = calls.slice(0, context.expanded ? 256 : 32);
  return record_block(
    () => shown,
    (records) => {
      const blocks: ToolBlock[] = [];
      const add = (component: Component) => blocks.push({ component });
      let reads: ReadMember[] = [];
      let writes: WriteMember[] = [];
      const flush_writes = () => {
        const members = writes;
        if (members.length) add(write_action_component(() => members, theme));
        writes = [];
      };
      const flush_reads = () => {
        if (reads.length) add(groupedReadComponent({ members: reads }, theme));
        reads = [];
      };
      for (const [index, call] of records.entries()) {
        const preview: CallPreview = details?.cpi_calls?.[call.id] ?? {
          args: fallback_args(call.args),
          details: undefined,
          text: call.error ?? "",
          order: index,
        };
        const pending = call.status === "running";
        const add_limit = () => {
          if (preview.limited)
            add(
              new Text(
                theme.fg(
                  "muted",
                  "   └ Nested rendering metadata was truncated",
                ),
                0,
                0,
              ),
            );
        };
        const is_error = call.status === "error" || call.status === "cancelled";
        if (is_write_action(call.name) && renderers.has(call.name)) {
          flush_reads();
          writes.push({
            id: call.id,
            command: call.name,
            path:
              typeof preview.args.path === "string"
                ? preview.args.path
                : undefined,
            isError: is_error,
            limited: preview.limited,
            result: pending
              ? undefined
              : {
                  details: preview.details as WriteDetails,
                  content: [
                    { type: "text", text: preview.text || call.error || "" },
                  ],
                },
          });
          continue;
        }
        flush_writes();
        const read_details = preview.details as { kind?: string } | undefined;
        if (call.name === "read" && read_details?.kind !== "image") {
          reads.push({
            id: call.id,
            path:
              typeof preview.args.path === "string"
                ? preview.args.path
                : undefined,
            query:
              typeof preview.args.query === "string"
                ? preview.args.query
                : undefined,
            order: pending ? index : 256 + preview.order,
            isError: is_error,
            result: pending
              ? undefined
              : {
                  details: preview.details as ReadValue["details"],
                  content: [
                    { type: "text", text: preview.text || call.error || "" },
                  ],
                },
          });
          if (preview.limited) {
            flush_reads();
            add_limit();
          }
          continue;
        }
        flush_reads();
        const tool = renderers.get(call.name);
        const state = states.get(call.id) ?? {};
        states.set(call.id, state);
        const child_context: ToolRenderContext = {
          ...context,
          args: preview.args,
          toolCallId: call.id,
          state,
          lastComponent: undefined,
          isPartial: pending,
          executionStarted: true,
          argsComplete: true,
          isError: is_error,
          showImages: false,
        };
        try {
          const call_component = tool?.renderCall?.(
            preview.args,
            theme,
            child_context,
          );
          if (call_component) add(call_component);
          if (!pending && tool?.renderResult) {
            add(
              tool.renderResult(
                {
                  content: [
                    { type: "text", text: preview.text || call.error || "" },
                  ],
                  details: preview.details,
                  isError: is_error,
                },
                { expanded: context.expanded, isPartial: false },
                theme,
                child_context,
              ),
            );
            add_limit();
            continue;
          }
          if (pending && call_component) continue;
        } catch {}
        const glyph = pending ? "⏳" : is_error ? " ✗" : " ✓";
        const color = pending ? "warning" : is_error ? "error" : "success";
        const label = oneLine(
          String(
            preview.args.description ??
              preview.args.path ??
              preview.args.query ??
              call.args,
          ),
        );
        const duration =
          call.durationMs === undefined
            ? ""
            : ` (${Math.round(call.durationMs)}ms)`;
        const cost = call.cost ? ` · $${call.cost.toPrecision(2)}` : "";
        add(
          new Text(
            theme.fg(color, `${glyph} ${call.name}: `) +
              theme.fg("dim", label) +
              theme.fg("muted", duration + cost),
            0,
            0,
          ),
        );
        if (call.error)
          add(new Text(theme.fg("error", `   └ ${oneLine(call.error)}`), 0, 0));
        add_limit();
      }
      flush_reads();
      flush_writes();
      if (shown.length < calls.length)
        add(
          new Text(
            theme.fg(
              "muted",
              `   … ${calls.length - shown.length} more calls${context.expanded ? " (display limit)" : " · expand to show"}`,
            ),
            0,
            0,
          ),
        );
      return blocks;
    },
    theme,
  );
}
