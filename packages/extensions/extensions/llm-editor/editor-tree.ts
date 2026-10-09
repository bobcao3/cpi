import {
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import {
  getLanguageFromPath,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { sanitizeActivityText } from "../lib/activity.ts";
import { diffContent } from "./diff-content.ts";
import { fileLabel, oneLine } from "./read-label.ts";
import { stream_tail, type WriteDetails } from "./write-record.ts";

interface EditorArgs {
  path?: string;
  instruction?: string;
  patch?: string;
  file_text?: string;
}

export function renderEditorTree(
  command: string,
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: ToolTreeContext,
): ToolTreeNode[] {
  const args = snapshot.args as EditorArgs;
  const details = snapshot.result?.details as WriteDetails | undefined;
  const path = details?.path ?? args.path;
  const id = context.toolCallId;
  const complete = snapshot.phase === "complete";
  const failed =
    snapshot.isError || details?.kind === "error" || Boolean(details?.failure);
  const text =
    snapshot.result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "";
  if (!complete && command === "edit" && text)
    context.state.editorTranscript = sanitizeActivityText(text);
  const transcript =
    typeof context.state.editorTranscript === "string"
      ? context.state.editorTranscript
      : "";
  const children: ToolTreeNode[] = [];
  if (args.instruction)
    children.push({
      id: `${id}/instruction`,
      label: "Instruction",
      content: { text: sanitizeActivityText(args.instruction) },
    });
  if (args.patch)
    children.push({
      id: `${id}/patch`,
      label: "Patch",
      content: { text: sanitizeActivityText(args.patch), format: "diff" },
    });
  if (args.file_text !== undefined)
    children.push({
      id: `${id}/preview`,
      label: "Preview",
      content: {
        text: sanitizeActivityText(args.file_text),
        format: "code",
        language: path ? getLanguageFromPath(path) : undefined,
      },
    });
  if (transcript) {
    children.push({
      id: `${id}/editor-transcript`,
      label: "Editor transcript",
      content: { text: transcript },
    });
    if (!complete)
      children.push({
        id: `${id}/editor-preview`,
        label: "Recent editor output",
        content: { text: stream_tail(transcript).join("\n") },
        defaultOpen: true,
      });
  }
  if (details?.diffOps?.length)
    children.push({
      id: `${id}/diff`,
      label: "Diff",
      content: diffContent(details.diffOps, theme),
      defaultOpen: true,
    });
  if (failed) {
    const error = sanitizeActivityText(
      details?.message || text || "Edit failed",
    );
    children.push({
      id: `${id}/error`,
      label: "Error",
      summary: oneLine(error),
      status: "error",
      content: { text: error },
    });
    if (details?.failure)
      children.push({
        id: `${id}/failure`,
        label: "Failure details",
        status: "error",
        content: {
          text: sanitizeActivityText(JSON.stringify(details.failure, null, 2)),
        },
      });
  }
  const applied =
    details?.hunks === undefined
      ? ""
      : `applied ${details.hunks} hunk${details.hunks === 1 ? "" : "s"}`;
  const summary = !complete
    ? undefined
    : details?.kind === "create"
      ? `created ${details.bytes} bytes`
      : applied
        ? `${applied}${failed ? " before failure" : ""}${details?.rewrite ? ", whole-file rewrite" : ""}`
        : failed
          ? "failed"
          : undefined;
  const color = !complete ? "warning" : failed ? "error" : "success";
  return [
    {
      id,
      label:
        theme.fg(color, `${command} `) +
        fileLabel(path, theme, "text", context.cwd),
      summary:
        summary === undefined
          ? undefined
          : theme.fg(failed ? "error" : "dim", summary),
      metadata:
        snapshot.durationMs === undefined
          ? undefined
          : [theme.fg("muted", `${Math.round(snapshot.durationMs)}ms`)],
      status: complete
        ? failed
          ? "error"
          : "success"
        : snapshot.phase === "running"
          ? "running"
          : "queued",
      children,
      defaultOpen: Boolean(
        failed || details?.diffOps?.length || (!complete && transcript),
      ),
    },
  ];
}
