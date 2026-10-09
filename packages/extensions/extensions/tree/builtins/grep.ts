import type { ToolRenderers } from "../renderer-types.ts";
import { renderToolPath, str } from "./render-utils.ts";
import {
  previewNode,
  resultNotices,
  textOutput,
  toolStatus,
} from "./tree-content.ts";

export const grepRenderers: ToolRenderers = {
  renderTree(snapshot, theme, context) {
    const args = snapshot.args as {
      path?: string;
      pattern?: string;
      glob?: string;
      limit?: number;
    };
    const id = context.toolCallId;
    const output = textOutput(snapshot).trim();
    const children = output
      ? [
          previewNode(
            `${id}/results`,
            snapshot.isError ? "Error" : "Results",
            { text: output },
            theme,
            15,
          ),
        ]
      : [];
    children.push(...resultNotices(id, snapshot.result?.details));
    return [
      {
        id,
        label: "grep",
        summary: [
          args.pattern,
          renderToolPath(str(args.path), theme, context.cwd, {
            emptyFallback: ".",
          }),
        ]
          .filter(Boolean)
          .join(" in "),
        metadata: [
          args.glob ? `glob ${args.glob}` : "",
          args.limit != null ? `limit ${args.limit}` : "",
        ].filter(Boolean),
        status: toolStatus(snapshot),
        children,
        defaultOpen: true,
      },
    ];
  },
};
