import { getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import { numbered_code_content } from "../../presentation/code-content.ts";
import type { ToolRenderers } from "../renderer-types.ts";
import type { ToolTreeNode } from "../tool-tree.ts";
import {
  normalizeDisplayText,
  renderToolPath,
  replaceTabs,
  str,
} from "./render-utils.ts";
import { textOutput, toolStatus } from "./tree-content.ts";

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
    const displayContent = replaceTabs(normalizeDisplayText(content ?? ""));
    const language = path ? getLanguageFromPath(path) : undefined;
    const children: ToolTreeNode[] = content
      ? [
          {
            id: `${id}/content`,
            label: "Content",
            summary: `${displayContent.split("\n").length} lines`,
            content: numbered_code_content(displayContent, theme, language, {
              maxVisualLines: 10,
            }),
            children: [
              {
                id: `${id}/content/full`,
                label: "Full content",
                content: numbered_code_content(displayContent, theme, language),
                defaultOpen: false,
              },
            ],
            defaultOpen: true,
          },
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
