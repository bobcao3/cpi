import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  type Component,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { kittyProbeSucceeded } from "../lib/kitty-probe.ts";
import { renderKittyReadImage } from "./kitty-image.ts";
import {
  HEAD_ERROR,
  HEAD_READ,
  HEAD_TREE,
  faint,
  readFileLabel,
  groupedReadComponent,
  oneLine,
  readBatch,
  readDescription,
  type ReadValue,
  rangeLabel,
} from "./read-batch.ts";

function compactLine(value: string) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return [truncateToWidth(value, width, "…")];
    },
  };
}

function withGroup(
  grouped: Component | undefined,
  standalone: Component,
): Component {
  if (!grouped) return standalone;
  const container = new Container();
  container.addChild(grouped);
  container.addChild(standalone);
  return container;
}

export function renderReadCall(
  args: { path?: string; query?: string },
  theme: Theme,
  context: {
    isPartial: boolean;
    toolCallId?: string;
    invalidate?: () => void;
  },
) {
  if (!context.isPartial) return new Container();
  const batch = readBatch(context.toolCallId);
  if (batch) {
    if (batch.members[0]?.id !== context.toolCallId) return new Container();
    batch.refresh = context.invalidate;
    return groupedReadComponent(batch, theme);
  }
  const file = readFileLabel(args.path, theme);
  const query = oneLine(args.query || "");
  return compactLine(
    theme.fg("warning", "⏳ Reading ") +
      file +
      theme.fg("text", query ? ` for ${query}` : ""),
  );
}

export function renderReadResult(
  result: ReadValue,
  options: { isPartial: boolean },
  theme: Theme,
  context: {
    args?: unknown;
    toolCallId?: string;
    isError: boolean;
    showImages: boolean;
    state: { kittyImage?: Parameters<typeof renderKittyReadImage>[3] };
    invalidate: () => void;
  },
) {
  if (options.isPartial) return new Container();
  const args = context.args as { path?: string } | undefined;
  const batch = readBatch(context.toolCallId);
  const isLeader = Boolean(
    batch && batch.members[0]?.id === context.toolCallId,
  );
  if (isLeader) batch.refresh = context.invalidate;
  const file = readFileLabel(args?.path, theme);
  const details = result.details;
  if (batch && !isLeader && details?.kind !== "image") return new Container();
  const grouped =
    isLeader && batch ? groupedReadComponent(batch, theme) : undefined;
  if (grouped && details?.kind !== "image") return grouped;
  if (context.isError || details?.kind === "error") {
    const error = oneLine(
      details?.message ||
        result.content?.find((part) => part.type === "text")?.text ||
        "Read failed",
    );
    return compactLine(
      theme.fg("error", HEAD_ERROR) + file + theme.fg("text", `: ${error}`),
    );
  }
  if (details?.kind === "content")
    return compactLine(
      theme.fg("success", HEAD_READ) +
        file +
        (details.lineCount === undefined
          ? ""
          : theme.fg("dim", ":") +
            faint(theme, "warning", `${details.lineCount} lines`)),
    );
  if (details?.kind === "tree")
    return compactLine(theme.fg("success", HEAD_TREE) + file);
  if (
    details?.kind === "image" &&
    context.showImages &&
    kittyProbeSucceeded()
  ) {
    const image = result.content?.find(
      (part) => part.type === "image" && part.data && part.mimeType,
    );
    if (image?.data && image.mimeType) {
      const notes =
        result.content
          ?.filter((part) => part.type === "text")
          .flatMap((part) => (part.text ?? "").split("\n")) ?? [];
      const imageComponent = renderKittyReadImage(
        { data: image.data, mimeType: image.mimeType },
        notes.map((line) => theme.fg("toolOutput", line)),
        theme.fg("success", HEAD_READ) + file,
        (context.state.kittyImage ??= {}),
        context.invalidate,
      );
      return withGroup(grouped, imageComponent);
    }
  }
  const summary = readDescription(details);
  const ranges = rangeLabel(details ?? {});
  const standalone = compactLine(
    theme.fg("success", HEAD_READ) +
      file +
      theme.fg("dim", ":") +
      (ranges ? faint(theme, "warning", ranges) : "") +
      theme.fg("dim", ` ${summary}`),
  );
  return withGroup(grouped, standalone);
}
