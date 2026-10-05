/**
 * `view` on a file: delegate to the Viewer subagent. Mirrors SWE-Edit §3.1 —
 * query-conditioned snippet extraction beats raw dumps on recall + context.
 * The viewer returns a bounded JSON object, validated before rendering.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { runSubagent } from "./subagent.ts";
import { loadEditorText, fmt } from "./text.ts";
import { lineBodies, numberLines } from "./lines.ts";

export interface ViewFileOptions {
  query: string;
  provider: string;
  modelId: string;
  cwd: string;
  id: string;
  signal?: AbortSignal;
  timeoutMs: number;
  transcriptDir: string;
  maxTranscripts: number;
  maxFileBytes: number;
  onStream?: (accumulated: string) => void;
  thinkingLevel?: string;
}

export function parseViewerJson(text: string): {
  summary: string;
  ranges: number[][];
} | null {
  if (Buffer.byteLength(text, "utf8") > 65536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const { one_line_summary: summary, ranges } = parsed as Record<
    string,
    unknown
  >;
  if (
    typeof summary !== "string" ||
    !summary.trim() ||
    summary.length > 240 ||
    /[\r\n]/.test(summary) ||
    !Array.isArray(ranges) ||
    ranges.length > 128
  )
    return null;
  const result: number[][] = [];
  for (const item of ranges) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { start, end } = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      (start as number) < 1 ||
      (end as number) < (start as number)
    )
      return null;
    result.push([start as number, end as number]);
  }
  result.sort((a, b) => a[0] - b[0]);
  const merged: number[][] = [];
  for (const [start, end] of result) {
    const last = merged.at(-1);
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return { summary: summary.trim(), ranges: merged };
}

export function renderRanges(
  lines: string[],
  ranges: number[][],
  linesOmitted: string,
): string {
  const out: string[] = [];
  let lastEnd = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(1, s);
    const end = Math.min(lines.length, e);
    if (end < start) continue;
    if (lastEnd && start > lastEnd + 1)
      out.push(fmt(linesOmitted, { n: start - lastEnd - 1 }));
    for (let i = start - 1; i < end; i++) out.push(`${i + 1}|${lines[i]}`);
    lastEnd = end;
  }
  return out.join("\n");
}

export async function viewFile(
  path: string,
  opts: ViewFileOptions,
): Promise<{
  text: string;
  summary?: string;
  ranges?: number[][];
  error?: string;
  usage?: { input: number; output: number };
}> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  let content: string;
  try {
    const st = await stat(abs);
    if (!st.isFile())
      return { text: "", error: fmt(T.errors.not_a_file, { path: abs }) };
    if (st.size > opts.maxFileBytes)
      return {
        text: "",
        error: fmt(T.errors.file_too_large, {
          size: st.size,
          limit: opts.maxFileBytes,
          path: abs,
        }),
      };
    content = await readFile(abs, "utf-8");
  } catch (err) {
    return {
      text: "",
      error: fmt(T.errors.cannot_read, {
        path: abs,
        reason: (err as Error).message,
      }),
    };
  }

  const lines = lineBodies(content);
  const numbered = numberLines(content);
  const task = fmt(T.tasks.viewer, { content: numbered, query: opts.query });
  const res = await runSubagent({
    role: "viewer",
    title: basename(abs),
    systemPrompt: T.system.viewer,
    task,
    provider: opts.provider,
    modelId: opts.modelId,
    cwd: opts.cwd,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    transcriptDir: opts.transcriptDir,
    id: opts.id,
    maxTranscripts: opts.maxTranscripts,
    onStream: opts.onStream,
    thinkingLevel: opts.thinkingLevel,
    maxOutputBytes: 65536,
  });

  if (res.timedOut)
    return {
      text: "",
      error: fmt(T.errors.viewer_timeout, { ms: opts.timeoutMs }),
    };
  if (res.aborted) return { text: "", error: T.errors.aborted };
  if (res.spawnError)
    return {
      text: "",
      error: fmt(T.errors.subagent_start_failed, { reason: res.spawnError }),
    };
  if (res.outputOverflow) {
    return { text: "", error: T.errors.viewer_truncated };
  }
  const view = parseViewerJson(res.text);
  if (!view)
    return {
      text: "",
      error: fmt(T.errors.viewer_bad_output, {
        tail: res.text.slice(0, 400),
      }),
    };
  const { ranges, summary } = view;
  if (ranges.length === 0)
    return {
      text: T.messages.view_no_ranges,
      summary: summary.trim(),
      ranges: [],
      usage: res.usage,
    };
  const visibleRanges = ranges
    .map(([start, end]) => [Math.max(1, start), Math.min(lines.length, end)])
    .filter(([start, end]) => end >= start);
  return {
    text: renderRanges(lines, ranges, T.messages.lines_omitted),
    summary: summary.trim(),
    ranges: visibleRanges,
    usage: res.usage,
  };
}
