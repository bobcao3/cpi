import {
  type ToolRenderers,
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Component } from "@earendil-works/pi-tui";

export function legacy_child(
  name: string,
  renderers: ToolRenderers,
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: ToolTreeContext,
): readonly ToolTreeNode[] {
  const expanded = context.viewState.expanded ?? false;
  const renderer_context: Parameters<
    NonNullable<ToolRenderers["renderCall"]>
  >[2] = {
    args: snapshot.args,
    toolCallId: context.toolCallId,
    cwd: context.cwd,
    state: context.state,
    invalidate: context.invalidate,
    executionStarted:
      snapshot.phase === "running" || snapshot.phase === "complete",
    argsComplete: snapshot.phase !== "arguments",
    isPartial: snapshot.phase !== "complete",
    expanded,
    showImages: false,
    isError: snapshot.isError,
    durationMs: snapshot.durationMs,
    outputPad: 0,
    lastComponent: undefined,
  };
  const children: ToolTreeNode[] = [];
  const body = (section: string, component: Component | undefined) => {
    if (!component) return;
    children.push({
      id: `${context.toolCallId}/custom/${section}`,
      label: section,
      defaultOpen: true,
      content: {
        component,
        text: component
          .render(100)
          .slice(0, 256)
          .map(stripTerminalSequences)
          .join("\n"),
      },
    });
  };
  body("Call", renderers.renderCall?.(snapshot.args, theme, renderer_context));
  if (snapshot.result)
    body(
      "Result",
      renderers.renderResult?.(
        snapshot.result,
        { expanded, isPartial: snapshot.phase !== "complete" },
        theme,
        renderer_context,
      ),
    );
  return [
    {
      id: context.toolCallId,
      label: name,
      status: snapshot.isError
        ? "error"
        : snapshot.phase === "complete"
          ? "success"
          : "running",
      defaultOpen: true,
      children,
    },
  ];
}
