import {
  type ToolTreeBatchCall,
  type ToolTreeContext,
  type ToolTreeNode,
  type ToolTreeSnapshot,
} from "../tree/index.ts";
import {
  getLanguageFromPath,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import {
  readFileLabel,
  oneLine,
  rangeLabel,
  readDescription,
  type ReadDetails,
} from "./read-label.ts";

function faintWarning(theme: Theme, text: string): string {
  return `\x1b[2m${theme.fg("warning", text)}\x1b[22m`;
}

export function renderReadTree(
  snapshot: ToolTreeSnapshot,
  theme: Theme,
  context: ToolTreeContext,
): ToolTreeNode[] {
  const args = snapshot.args as { path?: string; query?: string };
  const details = snapshot.result?.details as ReadDetails | undefined;
  const path = details?.path ?? args.path;
  const id = context.toolCallId;
  const text = sanitizeActivityText(
    snapshot.result?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n") ?? "",
  );
  const failed = snapshot.isError || details?.kind === "error";
  const error = sanitizeActivityText(details?.message || text || "Read failed");
  const children: ToolTreeNode[] = [];
  if (args.query) {
    children.push({
      id: `${id}/query`,
      label: "Query",
      summary: oneLine(args.query),
      content: { text: sanitizeActivityText(args.query) },
    });
  }
  if (failed) {
    children.push({
      id: `${id}/error`,
      label: "Error",
      status: "error",
      content: { text: error },
    });
  } else if (snapshot.result) {
    const language = path ? getLanguageFromPath(path) : undefined;
    if (details?.ranges?.length) {
      const ranges: ToolTreeNode[] = [];
      const seen = new Set<string>();
      const lines = (details.text ?? text).split("\n");
      for (const [start, end] of details.ranges) {
        const key = `${start}-${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const rangeText = lines
          .filter((line) => {
            const number = /^(\d+)\|/.exec(line)?.[1];
            return number !== undefined && +number >= start && +number <= end;
          })
          .join("\n");
        ranges.push({
          id: `${id}/ranges/${key}`,
          label: faintWarning(
            theme,
            `L${start}${start === end ? "" : `-${end}`}`,
          ),
          summary: faintWarning(theme, `${end - start + 1} lines`),
          content: {
            text: sanitizeActivityText(rangeText),
            format: "code",
            language,
          },
        });
      }
      children.push({
        id: `${id}/ranges`,
        label: "Ranges",
        summary: faintWarning(theme, rangeLabel(details)),
        children: ranges,
      });
    }
    const images = snapshot.result.content.filter(
      (part) => part.type === "image",
    );
    for (const [index, image] of images.entries()) {
      children.push({
        id: `${id}/image/${index}`,
        label: "Image",
        content: {
          text: readDescription(details),
          image: { data: image.data, mimeType: image.mimeType },
        },
        defaultOpen: true,
      });
    }
    if (text) {
      children.push({
        id: `${id}/preview`,
        label: images.length
          ? "Notes"
          : details?.kind === "tree"
            ? "Directory"
            : details?.kind === "video"
              ? "Video"
              : "Preview",
        content: {
          text,
          format:
            details?.kind === "content" || details?.kind === "view"
              ? "code"
              : "text",
          language,
        },
      });
    }
  }
  const summary = failed
    ? theme.fg("text", oneLine(error))
    : !snapshot.result
      ? args.query
        ? theme.fg("text", `for ${oneLine(args.query)}`)
        : undefined
      : details?.kind === "content"
        ? details.lineCount === undefined
          ? undefined
          : faintWarning(theme, `${details.lineCount} lines`)
        : [
            rangeLabel(details ?? {})
              ? faintWarning(theme, rangeLabel(details ?? {}))
              : "",
            theme.fg("dim", readDescription(details)),
          ]
            .filter(Boolean)
            .join(theme.fg("dim", " · "));
  const color =
    snapshot.phase !== "complete" ? "warning" : failed ? "error" : "success";
  return [
    {
      id,
      label:
        theme.fg(color, "read ") +
        readFileLabel(path, theme, "dim", context.cwd),
      summary,
      metadata:
        snapshot.durationMs === undefined
          ? undefined
          : [theme.fg("muted", `${Math.round(snapshot.durationMs)}ms`)],
      status:
        snapshot.phase === "complete"
          ? failed
            ? "error"
            : "success"
          : snapshot.phase === "running"
            ? "running"
            : "queued",
      children,
      defaultOpen: details?.kind === "image",
    },
  ];
}

export function renderReadBatchTree(
  calls: readonly ToolTreeBatchCall[],
  theme: Theme,
  context: ToolTreeContext,
): readonly ToolTreeNode[] {
  if (calls.length === 1) return calls[0]!.roots;
  if (!calls.length) return [];
  const counts = new Map<NonNullable<ToolTreeNode["status"]>, number>();
  const entries: string[] = [];
  let hasImage = false;
  for (const call of calls) {
    const snapshot = call.snapshot;
    const args = snapshot.args as { path?: string; query?: string };
    const details = snapshot.result?.details as ReadDetails | undefined;
    const root = call.roots[0];
    const failed =
      snapshot.isError || details?.kind === "error" || root?.status === "error";
    const status =
      failed && snapshot.phase === "complete"
        ? "error"
        : (root?.status ??
          (snapshot.phase === "complete"
            ? "success"
            : snapshot.phase === "running"
              ? "running"
              : "queued"));
    counts.set(status, (counts.get(status) ?? 0) + 1);
    const file = readFileLabel(
      details?.path ?? args.path,
      theme,
      "dim",
      context.cwd,
    );
    const error = failed
      ? oneLine(
          details?.message ||
            snapshot.result?.content.find((part) => part.type === "text")
              ?.text ||
            "Read failed",
        )
      : "";
    const detail = failed ? theme.fg("error", error) : root?.summary;
    const query =
      args.query && snapshot.phase === "complete"
        ? theme.fg("text", ` for ${oneLine(args.query)}`)
        : "";
    entries.push(file + (detail ? theme.fg("dim", ":") + detail : "") + query);
    hasImage ||=
      details?.kind === "image" ||
      Boolean(snapshot.result?.content.some((part) => part.type === "image"));
  }
  const priority = [
    "running",
    "paused",
    "queued",
    "error",
    "cancelled",
    "warning",
    "detached",
    "success",
  ] as const;
  const status = priority.find((value) => counts.has(value)) ?? "success";
  const pending =
    status === "running" || status === "queued" || status === "paused";
  const color =
    pending || status === "warning"
      ? "warning"
      : status === "error" || status === "cancelled"
        ? "error"
        : "success";
  const summary = entries.join(theme.fg("dim", ", "));
  const fullSummary = sanitizeActivityText(summary);
  return [
    {
      id: context.toolCallId,
      label: theme.fg(color, pending ? "Reading" : "Read"),
      summary: truncateToWidth(summary, 240, "…"),
      metadata: [
        theme.fg("dim", `${calls.length} files`),
        ...priority
          .filter((value) => value !== "success" && counts.has(value))
          .map((value) =>
            theme.fg(
              value === "error" || value === "cancelled"
                ? "error"
                : value === "running" ||
                    value === "paused" ||
                    value === "queued" ||
                    value === "warning"
                  ? "warning"
                  : "dim",
              `${counts.get(value)} ${value === "error" ? "failed" : value === "queued" ? "pending" : value}`,
            ),
          ),
        ...(fullSummary.length > 65536
          ? [
              theme.fg(
                "warning",
                "Summary display limited; expand member files",
              ),
            ]
          : []),
      ],
      status,
      content: { text: fullSummary.slice(0, 65536) },
      children: calls.flatMap((call) => call.roots),
      defaultOpen: hasImage,
    },
  ];
}
