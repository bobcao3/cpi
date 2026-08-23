/**
 * `view` on a file: delegate to the Viewer subagent. Mirrors SWE-Edit §3.1 —
 * query-conditioned snippet extraction beats raw dumps on recall + context.
 * The `view-complete` ranges arg is read back from the $PI_SUBAGENT_COMPLETION
 * handoff file by runSubagent.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
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

/** Validate the view-complete `ranges` arg into [start, end] pairs; invalid elements are dropped, non-array is bad output, empty is legitimate. */
function normalizeRanges(raw: unknown): number[][] | null {
  if (!Array.isArray(raw)) return null;
  const ranges: number[][] = [];
  for (const r of raw) {
    let s = NaN;
    let e = NaN;
    if (Array.isArray(r) && r.length === 2) {
      s = Number(r[0]);
      e = Number(r[1]);
    } else if (r && typeof r === "object") {
      const o = r as Record<string, unknown>;
      s = Number(o.start);
      e = Number(o.end);
    }
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s)
      continue;
    ranges.push([s, e]);
  }
  return ranges;
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
  // The view-complete tool call IS the signal: missing/wrong tool => truncation.
  const c = res.completion;
  if (!c || c.tool !== "view-complete") {
    return { text: "", error: T.errors.viewer_truncated };
  }
  const ranges = normalizeRanges(c.args.ranges);
  if (!ranges) {
    return {
      text: "",
      error: fmt(T.errors.viewer_bad_output, {
        tail: JSON.stringify(c.args).slice(0, 400),
      }),
    };
  }
  if (ranges.length === 0) return { text: T.messages.view_no_ranges };
  return {
    text: renderRanges(lines, ranges, T.messages.lines_omitted),
    usage: res.usage,
  };
}
