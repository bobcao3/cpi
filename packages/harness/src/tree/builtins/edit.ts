import { Diff, getLanguageFromPath } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "../renderer-types.ts";
import type { ToolTreeNode } from "../tool-tree.ts";
import type { EditDiffError, EditDiffResult } from "./edit-preview.ts";
import { renderToolPath, str } from "./render-utils.ts";
import { textOutput, toolStatus } from "./tree-content.ts";

export type EditRenderState = { editPreview?: EditDiffResult | EditDiffError };

export const editRenderers: ToolRenderers = {
  renderTree(snapshot, theme, context) {
    const args = snapshot.args as { path?: string; file_path?: string };
    const path = str(args.file_path ?? args.path);
    const id = context.toolCallId;
    const preview = context.state.editPreview as EditRenderState["editPreview"];
    const details = snapshot.result?.details as { diff?: string } | undefined;
    const diff =
      details?.diff ??
      (preview && !("error" in preview) ? preview.diff : undefined);
    const children: ToolTreeNode[] = [];
    if (diff)
      children.push({
        id: `${id}/diff`,
        label: "Diff",
        content: {
          text: diff,
          format: "diff",
          language: path ? getLanguageFromPath(path) : undefined,
          component: new Diff(diff, { filePath: path ?? undefined, theme }),
        },
        defaultOpen: true,
      });
    const error = snapshot.isError
      ? textOutput(snapshot)
      : preview && "error" in preview
        ? preview.error
        : undefined;
    if (error)
      children.push({
        id: `${id}/error`,
        label: "Error",
        status: "error",
        content: { text: error },
        defaultOpen: true,
      });
    return [
      {
        id,
        label: "edit",
        summary: renderToolPath(path, theme, context.cwd),
        status: toolStatus(snapshot),
        children,
        defaultOpen: true,
      },
    ];
  },
};
