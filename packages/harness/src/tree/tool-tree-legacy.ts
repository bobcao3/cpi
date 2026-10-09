import { type Component, Container, isImageLine } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./renderer-types.ts";
import type {
  ToolTreeContext,
  ToolTreeNode,
  ToolTreeSnapshot,
} from "./tool-tree.ts";

export function createLegacyToolTree(
  name: string,
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: ToolTreeContext,
  renderers: ToolRenderers,
): readonly ToolTreeNode[] {
  const body = new Container();
  const expanded =
    context.viewState.open.get(context.toolCallId) ??
    context.viewState.expanded ??
    false;
  const legacyContext: Parameters<NonNullable<ToolRenderers["renderCall"]>>[2] =
    {
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
  const call = renderers.renderCall?.(snapshot.args, theme, {
    ...legacyContext,
    lastComponent: context.state.legacyCallComponent as Component | undefined,
  });
  if (call) {
    context.state.legacyCallComponent = call;
    body.addChild(call);
  }
  if (snapshot.result) {
    const result = renderers.renderResult?.(
      snapshot.result,
      {
        expanded,
        isPartial: snapshot.phase !== "complete",
      },
      theme,
      {
        ...legacyContext,
        lastComponent: context.state.legacyResultComponent as
          | Component
          | undefined,
      },
    );
    if (result) {
      context.state.legacyResultComponent = result;
      body.addChild(result);
    }
  }
  const lines = () =>
    body
      .render(100)
      .filter((line) => !isImageLine(line))
      .slice(0, 256);
  return [
    {
      id: context.toolCallId,
      label: name,
      status:
        snapshot.phase === "complete"
          ? snapshot.isError
            ? "error"
            : "success"
          : snapshot.phase === "arguments"
            ? undefined
            : snapshot.phase,
      defaultOpen: true,
      content: {
        component: body,
        text: lines().join("\n"),
      },
    },
  ];
}
