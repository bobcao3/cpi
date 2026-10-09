import type { NestedToolCalls } from "@earendil-works/pi-ai";
import {
  type ObjectTreeNode,
  tree_snapshot,
  tree_text,
} from "./object-tree-data.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./renderer-types.ts";
import type {
  ToolTreeContext,
  ToolTreeNestedCall,
  ToolTreeNode,
  ToolTreeSnapshot,
} from "./tool-tree.ts";
import { resolveToolTree } from "./tool-tree-resolver.ts";
import {
  assembleToolTreeCalls,
  type ToolTreeCallPresentation,
} from "./tool-tree-calls.ts";
import { createLegacyToolTree } from "./tool-tree-legacy.ts";

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function objectNode(id: string, label: string, value: unknown): ToolTreeNode {
  const snapshot = tree_snapshot(value);
  const root: ToolTreeNode = { id, label };
  const stack: { source: ObjectTreeNode; target: ToolTreeNode }[] = [
    { source: snapshot, target: root },
  ];
  let count = 0;
  while (stack.length && count++ < 1200) {
    const { source, target } = stack.pop()!;
    if (source.kind === "object" || source.kind === "array") {
      target.summary = `${source.children.length}${source.limited ? "+" : ""} ${source.kind === "array" ? "items" : "fields"}`;
      const children: ToolTreeNode[] = [];
      target.children = children;
      for (const child of source.children) {
        const node: ToolTreeNode = {
          id: id + child.path,
          label: tree_text(child.key),
        };
        children.push(node);
        stack.push({ source: child, target: node });
      }
      if (source.limited)
        children.push({
          id: `${target.id}/$limit`,
          label: "Display limit; some source fields are unavailable",
          status: "warning",
        });
    } else {
      const text =
        source.kind === "string" ? JSON.stringify(source.value) : source.value;
      target.summary = text.split("\n", 1)[0]!.slice(0, 100);
      target.metadata = [source.kind];
      if (text.length > 100 || source.value.includes("\n"))
        target.content = { text: source.value };
      if (source.limited)
        target.metadata = [...target.metadata, "Display text limit"];
    }
  }
  if (stack.length)
    root.children = [
      { id: `${id}/$limit`, label: "Display node limit", status: "warning" },
    ];
  return root;
}

export function mergeToolTreeNestedCalls(
  live: readonly ToolTreeNestedCall[] = [],
  stored?: NestedToolCalls,
): readonly ToolTreeNestedCall[] {
  const merged = new Map(live.map((call) => [call.toolCallId, call]));
  for (const call of stored?.calls ?? []) {
    const existing = merged.get(call.id);
    merged.set(call.id, {
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments ?? {},
      parentToolCallId: call.id.includes("/")
        ? call.id.slice(0, call.id.lastIndexOf("/"))
        : undefined,
      phase: "complete",
      isError: call.status === "error",
      durationMs: call.durationMs,
      ...existing,
    });
  }
  return [...merged.values()].slice(0, 256);
}

export function createGenericToolTree(
  snapshot: ToolTreeSnapshot,
  _theme: Theme,
  context: ToolTreeContext,
  label = "Tool",
): readonly ToolTreeNode[] {
  const id = context.toolCallId;
  const children: ToolTreeNode[] = [];
  const args = objectNode(`${id}/arguments`, "Arguments", snapshot.args);
  if (args.children?.length || args.summary) children.push(args);
  const result = snapshot.result;
  const details = result?.details;
  const mcp = own(details, "mcp") ?? details;
  const outer =
    result?.structuredContent !== undefined
      ? result.structuredContent
      : own(mcp, "structuredContent");
  const isMcp =
    label.startsWith("mcp_") ||
    label.startsWith("mcp:") ||
    (typeof own(details, "server") === "string" &&
      typeof own(details, "tool") === "string") ||
    own(details, "mcp") !== undefined ||
    own(details, "protocol") === "mcp";
  const inner = isMcp ? own(outer, "structuredContent") : undefined;
  const structured = inner === undefined ? outer : inner;
  if (structured !== undefined)
    children.push(objectNode(`${id}/structured`, "Result", structured));
  for (
    let index = 0;
    index < (result?.content.length ?? 0) && index < 128;
    index++
  ) {
    const block = result!.content[index]!;
    if (block.type === "text")
      children.push({
        id: `${id}/text/${index}`,
        label: "Output",
        summary: tree_text(block.text).split("\n", 1)[0]!.slice(0, 100),
        content: { text: tree_text(block.text) },
      });
    else if (block.type === "image")
      children.push({
        id: `${id}/image/${index}`,
        label: "Image",
        summary: block.mimeType,
        content: {
          text: `[Image: ${block.mimeType}]`,
          image: { data: block.data, mimeType: block.mimeType },
        },
      });
  }
  const fullOutput =
    own(details, "fullOutputPath") ?? own(mcp, "fullOutputPath");
  if (typeof fullOutput === "string")
    children.push({
      id: `${id}/full-output`,
      label: "Full output",
      summary: tree_text(fullOutput),
      status: "warning",
      content: {
        text: `Read the retained full output at ${tree_text(fullOutput)}`,
      },
    });
  const nested = snapshot.nestedCalls ?? [];
  if (nested.length) {
    const presentations: ToolTreeCallPresentation[] = [];
    const resolve = context.state.toolRenderers as
      | ((name: string) => ToolRenderers | undefined)
      | undefined;
    context.state.nestedTreeStates ??= new Map<
      string,
      Record<string, unknown>
    >();
    const states = context.state.nestedTreeStates as Map<
      string,
      Record<string, unknown>
    >;
    for (const call of nested) {
      const childState = states.get(call.toolCallId) ?? {
        toolRenderers: resolve,
      };
      states.set(call.toolCallId, childState);
      const childContext = {
        ...context,
        toolCallId: call.toolCallId,
        state: childState,
      };
      const childSnapshot: ToolTreeSnapshot = {
        args: call.args,
        phase: call.phase,
        result: call.result,
        isError: call.isError,
        durationMs: call.durationMs,
      };
      const renderers = resolve?.(call.toolName);
      const forest =
        resolveToolTree(
          call.toolName,
          childSnapshot,
          _theme,
          childContext,
          renderers,
        ) ??
        createLegacyToolTree(
          call.toolName,
          childSnapshot,
          _theme,
          childContext,
          renderers!,
        );
      const node = forest[0];
      if (node && !call.result && call.phase === "complete")
        node.children = [
          ...(node.children ?? []),
          {
            id: `${call.toolCallId}/unavailable`,
            label: "Result detail was not retained",
            status: "warning",
          },
        ];
      presentations.push({
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        parentToolCallId: call.parentToolCallId,
        snapshot: childSnapshot,
        roots: forest,
      });
    }
    children.push({
      id: `${id}/calls`,
      label: "Calls",
      summary: `${nested.length} calls`,
      children: assembleToolTreeCalls(presentations, _theme, context),
      defaultOpen: true,
    });
  }
  return [
    {
      id,
      label,
      children,
      defaultOpen: false,
      status:
        snapshot.phase === "complete"
          ? snapshot.isError
            ? "error"
            : "success"
          : snapshot.phase === "running"
            ? "running"
            : "queued",
      summary: args.children
        ?.map(
          (node) =>
            `${node.label}=${node.summary ?? node.metadata?.join(" ") ?? "…"}`,
        )
        .join(" ")
        .slice(0, 160),
      metadata:
        snapshot.durationMs === undefined
          ? undefined
          : [`${snapshot.durationMs}ms`],
    },
  ];
}
