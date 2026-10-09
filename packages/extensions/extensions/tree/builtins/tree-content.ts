import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderDiff } from "@earendil-works/pi-coding-agent";
import { VisualLinePreview } from "../visual-line-preview.ts";
import { highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import type {
  ToolTreeContent,
  ToolTreeNode,
  ToolTreeSnapshot,
} from "../tool-tree.ts";
import { getTextOutput } from "./render-utils.ts";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";

export function toolStatus(snapshot: ToolTreeSnapshot): ToolTreeNode["status"] {
  return snapshot.phase === "complete"
    ? snapshot.isError
      ? "error"
      : "success"
    : snapshot.phase === "arguments"
      ? undefined
      : snapshot.phase;
}

export function textOutput(snapshot: ToolTreeSnapshot): string {
  return getTextOutput(snapshot.result, true).trimEnd();
}

export function previewNode(
  id: string,
  label: string,
  content: ToolTreeContent,
  theme: Theme,
  maxLines: number,
  keep: "start" | "end" = "start",
): ToolTreeNode {
  content = {
    ...content,
    text: stripTerminalSequences(content.text)
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "")
      .replace(/\t/g, "   "),
  };
  const styled =
    content.format === "code" && content.language
      ? highlightCode(content.text, content.language).join("\n")
      : content.format === "diff"
        ? renderDiff(content.text)
        : theme.fg("toolOutput", content.text);
  return {
    id,
    label,
    summary: `${content.text.split("\n").length} lines`,
    defaultOpen: true,
    content: {
      ...content,
      component: new VisualLinePreview({
        text: styled,
        maxVisualLines: maxLines,
        keep,
        formatHint: (hidden) =>
          theme.fg("muted", `… (${hidden} hidden lines; open Full content)`),
      }),
    },
    children: [
      { id: `${id}/full`, label: "Full content", content, defaultOpen: false },
    ],
  };
}

export function resultNotices(id: string, details: unknown): ToolTreeNode[] {
  if (!details || typeof details !== "object") return [];
  const data = details as {
    truncation?: TruncationResult;
    fullOutputPath?: string;
    resultLimitReached?: number;
    matchLimitReached?: number;
    entryLimitReached?: number;
    linesTruncated?: boolean;
  };
  const warnings: string[] = [];
  const limit =
    data.resultLimitReached ?? data.matchLimitReached ?? data.entryLimitReached;
  if (limit) warnings.push(`${limit} results limit`);
  const truncation = data.truncation;
  if (truncation?.truncated) {
    warnings.push(
      truncation.firstLineExceedsLimit
        ? `First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`
        : `Showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.truncatedBy === "lines" ? `${truncation.maxLines} line` : formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
    );
  }
  if (data.linesTruncated) warnings.push("Some lines truncated");
  const nodes: ToolTreeNode[] = [];
  if (warnings.length)
    nodes.push({
      id: `${id}/truncation`,
      label: "Truncated",
      summary: warnings.join("; "),
      status: "warning",
    });
  if (data.fullOutputPath)
    nodes.push({
      id: `${id}/full-output`,
      label: "Full output",
      summary: data.fullOutputPath,
      content: { text: data.fullOutputPath },
    });
  return nodes;
}

export function resultImages(
  id: string,
  snapshot: ToolTreeSnapshot,
): ToolTreeNode[] {
  return (snapshot.result?.content ?? []).flatMap((block, index) =>
    block.type === "image"
      ? [
          {
            id: `${id}/image/${index}`,
            label: "Image",
            summary: block.mimeType,
            content: {
              text: `[Image: ${block.mimeType}]`,
              image: { data: block.data, mimeType: block.mimeType },
            },
            defaultOpen: true,
          },
        ]
      : [],
  );
}
