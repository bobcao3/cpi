/**
 * Read batching: tracks concurrent `read` calls so the transcript shows one
 * folded group. Blocks wrap at entry boundaries, so a long batch never loses a
 * file name to truncation, and an entry's description drops to a `└` line when
 * it will not fit inline.
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  ExtensionAPI,
  SessionEntry,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  getCapabilities,
  hyperlink,
  stripTerminalSequences,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sanitizeActivityText } from "../lib/activity.ts";
import { getCwd } from "../lib/cwd.ts";
import { displayPath } from "../lib/path-display.ts";

interface ReadDetails {
  kind?: string;
  summary?: string;
  message?: string;
  ranges?: number[][];
  lineCount?: number;
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

const HEAD_PENDING = "⏳ Reading ";
// The leading space pads narrow glyphs to the two columns of the wide ⏳.
export const HEAD_READ = " ✓ Read ";
export const HEAD_TREE = " ✓ Listed dir: ";
export const HEAD_ERROR = " ✗ Failed to read ";

/** Wrap colored text in ANSI faint styling. */
export function faint(theme: Theme, color: ThemeColor, text: string): string {
  return `\x1b[2m${theme.fg(color, text)}\x1b[22m`;
}

export function oneLine(value: string): string {
  return sanitizeActivityText(value).split("\n", 1)[0].trim().slice(0, 240);
}

export function fileLabel(
  path: string | undefined,
  theme: Theme,
  color: "text" | "dim" = "text",
): string {
  const raw = path || "file";
  const name =
    sanitizeActivityText(displayPath(raw, getCwd())).trim() || "file";
  const linked = Boolean(path && getCapabilities().hyperlinks);
  const styled = theme.fg(color, linked ? `\x1b[4m${name}\x1b[24m` : name);
  return linked
    ? hyperlink(styled, pathToFileURL(resolve(getCwd(), raw)).href)
    : styled;
}

export function rangeLabel(details: ReadDetails): string {
  return (details.ranges ?? [])
    .map(
      ([start, end], index) =>
        `${index ? "" : "L"}${start}${end === start ? "" : `-${end}`}`,
    )
    .join(",");
}

export function readDescription(details: ReadDetails | undefined): string {
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

interface ReadBlock {
  head: string;
  entries: string[];
  desc?: string;
}

function groupedReadBlocks(batch: ReadBatch, theme: Theme): ReadBlock[] {
  const members = batch.members
    .filter((member) => member.result?.details?.kind !== "image")
    .sort((a, b) => a.order - b.order);
  const pendingHasQuery = members.some(
    (member) => !member.result && member.query,
  );
  const blocks: ReadBlock[] = [];
  let previous = "";
  let hasSuccess = false;
  const add = (head: string, entry: string, merge: boolean, desc?: string) => {
    if (merge) blocks[blocks.length - 1].entries.push(entry);
    else blocks.push({ head, entries: [entry], desc });
  };
  for (const member of members) {
    const kind = memberKind(member);
    const file = fileLabel(member.path, theme, "dim");
    const details = member.result?.details;
    const same = kind === previous;
    if (kind === "pending") {
      add(
        same
          ? " ".repeat(visibleWidth(HEAD_PENDING))
          : theme.fg("warning", HEAD_PENDING),
        file +
          theme.fg("text", member.query ? ` for ${oneLine(member.query)}` : ""),
        same && !pendingHasQuery,
      );
    } else if (kind === "content") {
      add(
        theme.fg("success", HEAD_READ),
        file +
          theme.fg("dim", ":") +
          faint(theme, "warning", `${details?.lineCount ?? "?"} lines`),
        same,
      );
      hasSuccess = true;
    } else if (kind === "tree") {
      add(theme.fg("success", HEAD_TREE), file, same);
      hasSuccess = true;
    } else if (kind === "error") {
      add(
        theme.fg("error", HEAD_ERROR),
        file + theme.fg("text", `: ${oneLine(errorText(member))}`),
        false,
      );
    } else {
      const range = kind === "view" ? rangeLabel(details ?? {}) : "";
      add(
        hasSuccess
          ? " ".repeat(visibleWidth(HEAD_READ))
          : theme.fg("success", HEAD_READ),
        file +
          theme.fg("dim", ":") +
          (range ? faint(theme, "warning", range) : ""),
        false,
        readDescription(details),
      );
      hasSuccess = true;
    }
    previous = kind;
  }
  return blocks;
}

function errorText(member: ReadMember): string {
  return (
    member.result?.details?.message ||
    member.result?.content?.find((part) => part.type === "text")?.text ||
    "Read failed"
  );
}

function foldBlocks(
  blocks: ReadBlock[],
  width: number,
  theme: Theme,
): string[] {
  const lines: string[] = [];
  const dim = (text: string) => theme.fg("dim", text);
  for (const block of blocks) {
    const indent = " ".repeat(visibleWidth(block.head));
    let line = block.head;
    let used = visibleWidth(block.head);
    block.entries.forEach((entry, index) => {
      const separator = index ? ", " : "";
      const size = visibleWidth(separator + entry);
      if (index && used + size > width) {
        lines.push(line);
        line = indent + entry;
        used = visibleWidth(line);
      } else {
        line += separator + entry;
        used += size;
      }
    });
    lines.push(line);
    if (block.desc) {
      const inline = ` ${dim(block.desc)}`;
      if (visibleWidth(line) + visibleWidth(inline) <= width)
        lines[lines.length - 1] += inline;
      else lines.push(indent + dim(`└ ${block.desc}`));
    }
  }
  return lines.flatMap((line) => wrapIndented(line, width));
}

function wrapIndented(line: string, width: number): string[] {
  if (visibleWidth(line) <= width) return [line];
  const indent = line.match(/^ */)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const hanging =
    indent + (stripTerminalSequences(rest).startsWith("└ ") ? "  " : "");
  const wrapped = wrapTextWithAnsi(
    rest,
    Math.max(1, width - hanging.length),
  ).filter((chunk) => visibleWidth(chunk));
  return wrapped.map(
    (chunk, index) => (index === 0 ? indent : hanging) + chunk,
  );
}

export function groupedReadComponent(batch: ReadBatch, theme: Theme) {
  return {
    invalidate() {},
    render(width: number): string[] {
      return foldBlocks(groupedReadBlocks(batch, theme), width, theme);
    },
  };
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
