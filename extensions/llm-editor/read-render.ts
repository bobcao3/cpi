import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  SessionEntry,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  Container,
  type Component,
  getCapabilities,
  hyperlink,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import { kittyProbeSucceeded } from "../lib/kitty-probe.ts";
import { renderKittyReadImage } from "./kitty-image.ts";

interface ReadDetails {
  kind?: string;
  summary?: string;
  message?: string;
  ranges?: number[][];
  lineCount?: number;
}

function oneLine(value: string): string {
  return sanitizeActivityText(value).split("\n", 1)[0].trim().slice(0, 240);
}

function fileLabel(
  path: string | undefined,
  theme: Theme,
  cwd?: string,
): string {
  const name = oneLine(basename(path || "file")) || "file";
  const linked = Boolean(path && getCapabilities().hyperlinks);
  const styled = theme.fg("text", linked ? `\x1b[4m${name}\x1b[24m` : name);
  return linked
    ? hyperlink(
        styled,
        pathToFileURL(resolve(cwd ?? process.cwd(), path!)).href,
      )
    : styled;
}

function compactLine(value: string) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return [truncateToWidth(value, width, "…")];
    },
  };
}

function rangeLabel(details: ReadDetails): string {
  return (details.ranges ?? [])
    .map(
      ([start, end], index) =>
        `${index ? "" : "L"}${start}${end === start ? "" : `-${end}`}`,
    )
    .join(",");
}

function readDescription(details: ReadDetails | undefined): string {
  const fallback =
    { image: "Image", video: "Video" }[details?.kind ?? ""] ??
    "Query complete (summary unavailable)";
  return oneLine(details?.summary || fallback);
}

function memberKind(member: ReadMember): string {
  if (!member.result) return "pending";
  if (member.isError || member.result.details?.kind === "error") return "error";
  return member.result.details?.kind || "other";
}

function groupedReadLines(
  batch: ReadBatch,
  theme: Theme,
  cwd?: string,
): string[] {
  const members = batch.members
    .filter((member) => member.result?.details?.kind !== "image")
    .sort((a, b) => a.order - b.order);
  const pendingHasQuery = members.some(
    (member) => !member.result && member.query,
  );
  const lines: string[] = [];
  let previous = "";
  let hasSuccess = false;
  for (const member of members) {
    const kind = memberKind(member);
    const file = fileLabel(member.path, theme, cwd);
    const details = member.result?.details;
    const same = kind === previous;
    if (kind === "pending") {
      const name =
        file +
        theme.fg("text", member.query ? ` for ${oneLine(member.query)}` : "");
      if (same && !pendingHasQuery)
        lines[lines.length - 1] += theme.fg("text", ", ") + name;
      else
        lines.push(
          (same
            ? " ".repeat(visibleWidth("⏳ Reading "))
            : theme.fg("warning", "⏳ Reading ")) + name,
        );
    } else if (kind === "content") {
      const name =
        file +
        theme.fg("text", ":") +
        theme.fg("warning", `${details?.lineCount ?? "?"} lines`);
      if (same) lines[lines.length - 1] += theme.fg("text", ", ") + name;
      else lines.push(theme.fg("success", "✓ Read ") + name);
      hasSuccess = true;
    } else if (kind === "tree") {
      if (same) lines[lines.length - 1] += theme.fg("text", ", ") + file;
      else lines.push(theme.fg("success", "✓ Listed dir: ") + file);
      hasSuccess = true;
    } else if (kind === "error") {
      const message = oneLine(
        details?.message ||
          member.result?.content?.find((part) => part.type === "text")?.text ||
          "Read failed",
      );
      lines.push(
        theme.fg("error", "✗ Failed to read ") +
          file +
          theme.fg("text", `: ${message}`),
      );
    } else {
      const range = kind === "view" ? rangeLabel(details ?? {}) : "";
      lines.push(
        (hasSuccess ? "       " : theme.fg("success", "✓ Read ")) +
          file +
          theme.fg("text", ":") +
          (range ? theme.fg("warning", range) : "") +
          theme.fg("text", ` ${readDescription(details)}`),
      );
      hasSuccess = true;
    }
    previous = kind;
  }
  return lines;
}

function groupedReadComponent(batch: ReadBatch, theme: Theme, cwd?: string) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return groupedReadLines(batch, theme, cwd).map((line) =>
        truncateToWidth(line, width, "…"),
      );
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
    cwd?: string;
    toolCallId?: string;
    invalidate?: () => void;
  },
) {
  if (!context.isPartial) return new Container();
  const batch = readBatch(context.toolCallId);
  if (batch) {
    if (batch.members[0]?.id !== context.toolCallId) return new Container();
    batch.refresh = context.invalidate;
    return groupedReadComponent(batch, theme, context.cwd);
  }
  const file = fileLabel(args.path, theme, context.cwd);
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
    cwd?: string;
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
  const file = fileLabel(args?.path, theme, context.cwd);
  const details = result.details;
  if (batch && !isLeader && details?.kind !== "image") return new Container();
  const grouped =
    isLeader && batch
      ? groupedReadComponent(batch, theme, context.cwd)
      : undefined;
  if (grouped && details?.kind !== "image") return grouped;
  if (context.isError || details?.kind === "error") {
    const error = oneLine(
      details?.message ||
        result.content?.find((part) => part.type === "text")?.text ||
        "Read failed",
    );
    return compactLine(
      theme.fg("error", "✗ Failed to read ") +
        file +
        theme.fg("text", `: ${error}`),
    );
  }
  if (details?.kind === "content")
    return compactLine(
      theme.fg("success", "✓ Read ") +
        file +
        (details.lineCount === undefined
          ? ""
          : theme.fg("text", ":") +
            theme.fg("warning", `${details.lineCount} lines`)),
    );
  if (details?.kind === "tree")
    return compactLine(theme.fg("success", "✓ Listed dir: ") + file);
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
        theme.fg("success", "✓ Read ") + file,
        (context.state.kittyImage ??= {}),
        context.invalidate,
      );
      return withGroup(grouped, imageComponent);
    }
  }
  const summary = readDescription(details);
  const ranges = rangeLabel(details ?? {});
  const standalone = compactLine(
    theme.fg("success", "✓ Read ") +
      file +
      theme.fg("text", ":") +
      (ranges ? theme.fg("warning", ranges) : "") +
      theme.fg("text", ` ${summary}`),
  );
  return withGroup(grouped, standalone);
}

export interface ReadValue {
  details?: ReadDetails;
  content?: { type: string; text?: string; data?: string; mimeType?: string }[];
}

export interface ReadMember {
  id: string;
  path?: string;
  query?: string;
  result?: ReadValue;
  isError: boolean;
  order: number;
}

export interface ReadBatch {
  members: ReadMember[];
  refresh?: () => void;
}

const MAX_GROUPED_READS = 64;
const MAX_TRACKED_READS = 4096;
const batches = new Map<string, ReadBatch>();
let order = 0;

export function readBatch(id: string | undefined): ReadBatch | undefined {
  const batch = batches.get(id ?? "");
  return batch && batch.members.length > 1 ? batch : undefined;
}

export function recordReadCalls(
  calls: readonly {
    id: string;
    name: string;
    arguments?: { path?: string; query?: string };
  }[],
): void {
  const reads = calls.filter((call) => call.name === "read");
  if (!reads.length) return;
  let batch = reads.map((call) => batches.get(call.id)).find(Boolean);
  for (const call of reads) {
    const args = call.arguments;
    const path = typeof args?.path === "string" ? args.path : undefined;
    const query = typeof args?.query === "string" ? args.query : undefined;
    const existing = batches
      .get(call.id)
      ?.members.find((member) => member.id === call.id);
    if (existing) {
      existing.path = path ?? existing.path;
      existing.query = query ?? existing.query;
      continue;
    }
    if (batches.size >= MAX_TRACKED_READS) break;
    if (!batch || batch.members.length >= MAX_GROUPED_READS)
      batch = { members: [] };
    batch.members.push({
      id: call.id,
      path,
      query,
      isError: false,
      order: order++,
    });
    batches.set(call.id, batch);
    batch.refresh?.();
  }
}

export function recordReadResult(
  id: string,
  result: ReadValue,
  isError: boolean,
): void {
  const batch = batches.get(id);
  const member = batch?.members.find((item) => item.id === id);
  if (!member || member.result) return;
  member.result = result;
  member.isError = isError;
  member.order = order++;
  batch?.refresh?.();
}

export function recordReadMessage(message: AssistantMessage): void {
  recordReadCalls(message.content.filter((part) => part.type === "toolCall"));
  if (message.stopReason !== "aborted" && message.stopReason !== "error")
    return;
  const error = {
    details: {
      kind: "error",
      message: message.errorMessage || "Operation aborted",
    },
  };
  for (const part of message.content) {
    if (part.type === "toolCall" && part.name === "read")
      recordReadResult(part.id, error, true);
  }
}

export function resetReadBatches(entries: readonly SessionEntry[]): void {
  batches.clear();
  order = 0;
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") recordReadMessage(message);
    else if (message.role === "toolResult")
      recordReadResult(message.toolCallId, message, message.isError);
  }
}

export function registerReadGrouping(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) =>
    resetReadBatches(ctx.sessionManager.getBranch()),
  );
  pi.on("session_tree", (_event, ctx) =>
    resetReadBatches(ctx.sessionManager.getBranch()),
  );
  pi.on("message_update", ({ message }) => {
    if (message.role === "assistant")
      recordReadCalls(
        message.content.filter((part) => part.type === "toolCall"),
      );
  });
  pi.on("message_end", ({ message }) => {
    if (message.role === "assistant") recordReadMessage(message);
  });
  pi.on("tool_execution_end", ({ toolName, toolCallId, result, isError }) => {
    if (toolName === "read") recordReadResult(toolCallId, result, isError);
  });
}
