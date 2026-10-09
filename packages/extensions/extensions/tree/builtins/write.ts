import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "../renderer-types.ts";
import {
  normalizeDisplayText,
  renderToolPath,
  replaceTabs,
  str,
} from "./render-utils.ts";
import { previewNode, textOutput, toolStatus } from "./tree-content.ts";

export const writeRenderers: ToolRenderers = {
  renderTree(snapshot, theme, context) {
    const args = snapshot.args as {
      path?: string;
      file_path?: string;
      content?: string;
    };
    const path = str(args.file_path ?? args.path);
    const content = str(args.content);
    const id = context.toolCallId;
    const children = content
      ? [
          previewNode(
            `${id}/content`,
            "Content",
            {
              text: replaceTabs(normalizeDisplayText(content)),
              format: "code",
              language: path ? getLanguageFromPath(path) : undefined,
            },
            theme,
            10,
          ),
        ]
      : [];
    if (content === null)
      children.push({
        id: `${id}/invalid-content`,
        label: "Invalid content",
        status: "error",
        content: { text: "Expected a string" },
      });
    if (snapshot.isError && snapshot.result)
      children.push({
        id: `${id}/error`,
        label: "Error",
        status: "error",
        content: { text: textOutput(snapshot) },
        defaultOpen: true,
      });
    return [
      {
        id,
        label: "write",
        summary: renderToolPath(path, theme, context.cwd),
        metadata: content
          ? [
              `${Buffer.byteLength(content)} bytes`,
              `${content.split("\n").length} lines`,
            ]
          : [],
        status: toolStatus(snapshot),
        children,
        defaultOpen: true,
      },
    ];
  },
};
