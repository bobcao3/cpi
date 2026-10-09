import { type ToolDefinition, type ToolTreeNode } from "../tree/index.ts";
import { formatCodemodeOutput } from "@earendil-works/pi-coding-agent";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { call_nodes, type CodeState } from "./tree-calls.ts";
import { script_node } from "./tree-source.ts";
import type { CodeDetails } from "./preview.ts";
import { style_tool_tree } from "../lib/tool-style.ts";

const HEADER =
  /^Script (completed|failed)\nWall time ([\d.]+) seconds\nOutput:\n$/;
const MAX_OUTPUT_CHARS = 65536;

export const codemode_renderers: Pick<
  ToolDefinition<any, CodeDetails, CodeState>,
  "renderShell" | "renderTree"
> = {
  renderShell: "self",
  renderTree(snapshot, theme, context) {
    const args = snapshot.args as { code?: unknown };
    const code = typeof args?.code === "string" ? args.code : "";
    const details = snapshot.result?.details;
    const calls = call_nodes(snapshot, theme, context);
    const running =
      details?.calls.filter((call) => call.status === "running").length ?? 0;
    const failed =
      details?.calls.filter(
        (call) => call.status === "error" || call.status === "cancelled",
      ).length ?? 0;
    const cost =
      details?.calls.reduce((total, call) => total + (call.cost ?? 0), 0) ?? 0;
    const children: ToolTreeNode[] = [
      script_node(context.toolCallId, code, theme),
    ];
    if (calls.length)
      children.push({
        id: `${context.toolCallId}/calls`,
        label: "Calls",
        defaultOpen: true,
        summary: `${calls.length} calls${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`,
        children: calls,
      });
    const content = snapshot.result?.content ?? [];
    const offset =
      content[0]?.type === "text" && HEADER.test(content[0].text) ? 1 : 0;
    const output = content
      .slice(offset)
      .flatMap((part, index) =>
        part.type === "text"
          ? [formatCodemodeOutput(part.text, details?.output?.[index + offset])]
          : [],
      )
      .join("\n");
    if (output)
      children.push({
        id: `${context.toolCallId}/output`,
        label: "Output",
        summary: output.split("\n", 1)[0],
        content: { text: output.slice(0, MAX_OUTPUT_CHARS) },
        ...(output.length > MAX_OUTPUT_CHARS
          ? {
              children: [
                {
                  id: `${context.toolCallId}/output/limit`,
                  label: "Output display limited",
                },
              ],
            }
          : {}),
      });
    for (const [index, image] of content
      .filter((part) => part.type === "image")
      .entries()) {
      const dimensions = getImageDimensions(image.data, image.mimeType);
      children.push({
        id: `${context.toolCallId}/image/${index}`,
        label: "Image",
        summary: `${image.mimeType}${dimensions ? ` · ${dimensions.widthPx}×${dimensions.heightPx}` : ""}`,
        defaultOpen: true,
        content: {
          text: `[image ${image.mimeType}]`,
          image: { data: image.data, mimeType: image.mimeType },
        },
      });
    }
    if (details?.fullOutputPath)
      children.push({
        id: `${context.toolCallId}/full-output`,
        label: "Full output",
        summary: details.fullOutputPath,
      });
    if (details?.outputMetadataLimited)
      children.push({
        id: `${context.toolCallId}/metadata-limit`,
        label: "Output type metadata exceeded the display limit",
      });
    return style_tool_tree(
      [
        {
          id: context.toolCallId,
          label: theme.fg("toolTitle", theme.bold("Code mode")),
          defaultOpen: true,
          summary: `JavaScript · ${code ? code.trimEnd().split("\n").length : 0} lines${running ? ` · ${running} running` : ""}${failed ? ` · ${failed} failed` : ""}`,
          metadata: [
            ...(snapshot.durationMs === undefined
              ? []
              : [`${(snapshot.durationMs / 1000).toFixed(2)}s`]),
            ...(cost ? [`$${cost.toPrecision(2)}`] : []),
          ],
          status: snapshot.isError
            ? "error"
            : snapshot.phase === "running"
              ? "running"
              : snapshot.phase === "complete"
                ? "success"
                : "queued",
          children,
        },
      ],
      theme,
    );
  },
};
