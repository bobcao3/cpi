import {
  assembleToolTreeCalls,
  createGenericToolTree,
  resolveToolTree,
  type ToolRenderers,
  type ToolTreeContext,
  type ToolTreeCallPresentation,
  type ToolTreeNestedCall,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import { type Theme } from "@earendil-works/pi-coding-agent";
import type { CallPreview, CodeDetails } from "./preview.ts";
import { legacy_child } from "./legacy-child.ts";

export interface CodeState extends Record<string, unknown> {
  nestedTreeStates?: Map<string, Record<string, unknown>>;
  toolRenderers?: (name: string) => ToolRenderers | undefined;
}

function arguments_value(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function call_nodes(
  snapshot: ToolTreeSnapshot<unknown, CodeDetails>,
  theme: Theme,
  context: ToolTreeContext<CodeState>,
): readonly ToolTreeNode[] {
  const states = (context.state.nestedTreeStates ??= new Map());
  const records = new Map<string, ToolTreeNestedCall>();
  for (const call of snapshot.nestedCalls ?? [])
    records.set(call.toolCallId, call);
  const calls = snapshot.result?.details?.calls ?? [];
  const ids = [
    ...new Set([...calls.map((call) => call.id), ...records.keys()]),
  ].slice(0, 256);
  const presentations: ToolTreeCallPresentation[] = [];
  for (const id of ids) {
    const call = calls.find((entry) => entry.id === id);
    const live = records.get(id);
    const name = call?.name ?? live!.toolName;
    const preview: CallPreview | undefined =
      snapshot.result?.details?.cpi_calls?.[id];
    const pending = call
      ? call.status === "running"
      : live!.phase !== "complete";
    const failed = call
      ? call.status === "error" || call.status === "cancelled"
      : live!.isError;
    const args =
      preview?.args ??
      (live?.args && typeof live.args === "object"
        ? (live.args as Record<string, unknown>)
        : arguments_value(call?.args ?? ""));
    const result = pending
      ? undefined
      : preview
        ? {
            content: [
              {
                type: "text" as const,
                text: preview.text || call?.error || "",
              },
            ],
            details: preview.details,
            structuredContent: preview.structuredContent,
            isError: failed,
          }
        : live?.result;
    const state = states.get(id) ?? {};
    state.toolRenderers = context.state.toolRenderers;
    states.set(id, state);
    const child_context: ToolTreeContext = {
      ...context,
      toolCallId: id,
      state,
    };
    const child_snapshot: ToolTreeSnapshot = {
      args,
      result,
      phase: pending ? "running" : "complete",
      isError: failed,
      durationMs: call?.durationMs ?? live?.durationMs,
    };
    let roots: readonly ToolTreeNode[];
    if (name.startsWith("models.")) {
      roots = [
        {
          id,
          label: name,
          summary: call?.args,
          status: pending ? "running" : failed ? "error" : "success",
          metadata: [
            ...(call?.durationMs === undefined
              ? []
              : [`${Math.round(call.durationMs)}ms`]),
            ...(call?.cost ? [`$${call.cost.toPrecision(2)}`] : []),
          ],
          ...(call?.error ? { content: { text: call.error } } : {}),
        },
      ];
    } else {
      const renderer = context.state.toolRenderers?.(name);
      try {
        roots =
          resolveToolTree(
            name,
            child_snapshot,
            theme,
            child_context,
            renderer,
          ) ??
          legacy_child(name, renderer!, child_snapshot, theme, child_context);
      } catch {
        roots = createGenericToolTree(
          child_snapshot,
          theme,
          child_context,
          name,
        );
      }
    }
    const notices: ToolTreeNode[] = [];
    if (!pending && !preview && !live?.result)
      notices.push({
        id: `${id}/unavailable`,
        label: "Result detail unavailable",
        summary: "The session retained nested-call metadata only",
      });
    if (preview?.limited)
      notices.push({
        id: `${id}/limited`,
        label: "Nested rendering metadata was truncated",
      });
    const projected = roots.map((root, index) => ({
      ...root,
      ...(index === 0 && notices.length
        ? { children: [...(root.children ?? []), ...notices] }
        : {}),
    }));
    presentations.push({
      toolCallId: id,
      toolName: name,
      parentToolCallId: live?.parentToolCallId,
      snapshot: child_snapshot,
      roots: projected,
    });
  }
  return assembleToolTreeCalls(presentations, theme, context);
}
