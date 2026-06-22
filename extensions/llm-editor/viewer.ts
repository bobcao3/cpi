/**
 * `view` on a file: delegate to the Viewer subagent.
 *
 * Reads the file, sends it (numbered, 1-indexed `LINE<TAB>CONTENT`) + the
 * natural-language query to the tool-less Viewer subagent, parses the JSON
 * line-range array it returns, and renders only those ranges (with line
 * numbers). Mirrors SWE-Edit's Viewer (§3.1): query-conditioned snippet
 * extraction beats raw dumps and classical retrieval on recall + context.
 * All prose lives in text.toml; this module holds logic.
 */

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { runSubagent } from "./subagent.ts";
import { loadEditorText, fmt } from "./text.ts";

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

function parseRanges(answer: string): number[][] | null {
  const first = answer.indexOf("[");
  const last = answer.lastIndexOf("]");
  if (first < 0 || last < 0 || last < first) return null;
  try {
    const arr = JSON.parse(answer.slice(first, last + 1)) as unknown;
    if (!Array.isArray(arr)) return null;
    const ranges: number[][] = [];
    for (const r of arr) {
      if (!Array.isArray(r) || r.length !== 2) continue;
      const s = Number(r[0]);
      const e = Number(r[1]);
      if (!Number.isInteger(s) || !Number.isInteger(e) || s < 1 || e < s) continue;
      ranges.push([s, e]);
    }
    return ranges;
  } catch {
    return null;
  }
}

export function renderRanges(lines: string[], ranges: number[][], linesOmitted: string): string {
  const out: string[] = [];
  let lastEnd = 0;
  for (const [s, e] of ranges) {
    const start = Math.max(1, s);
    const end = Math.min(lines.length, e);
    if (end < start) continue;
    if (lastEnd && start > lastEnd + 1) out.push(fmt(linesOmitted, { n: start - lastEnd - 1 }));
    for (let i = start - 1; i < end; i++) out.push(`${i + 1}\t${lines[i]}`);
    lastEnd = end;
  }
  return out.join("\n");
}

export async function viewFile(
  path: string,
  opts: ViewFileOptions,
): Promise<{ text: string; error?: string; usage?: { input: number; output: number } }> {
  const T = loadEditorText(opts.cwd);
  const abs = resolve(opts.cwd, path);
  let content: string;
  try {
    const st = await stat(abs);
    if (!st.isFile()) return { text: "", error: fmt(T.errors.not_a_file, { path: abs }) };
    if (st.size > opts.maxFileBytes)
      return {
        text: "",
        error: fmt(T.errors.file_too_large, { size: st.size, limit: opts.maxFileBytes, path: abs }),
      };
    content = await readFile(abs, "utf-8");
  } catch (err) {
    return {
      text: "",
      error: fmt(T.errors.cannot_read, { path: abs, reason: (err as Error).message }),
    };
  }

  const lines = content.split("\n");
  const numbered = lines.map((l, i) => `${i + 1}\t${l}`).join("\n");
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

  if (res.spawnError)
    return { text: "", error: fmt(T.errors.spawn_not_found, { reason: res.spawnError }) };
  if (res.timedOut)
    return { text: "", error: fmt(T.errors.viewer_timeout, { ms: opts.timeoutMs }) };
  const ranges = parseRanges(res.answer);
  if (!ranges) {
    return {
      text: "",
      error: fmt(T.errors.viewer_bad_output, { tail: res.answer.slice(0, 400) }),
    };
  }
  if (ranges.length === 0) return { text: T.messages.view_no_ranges };
  return {
    text: renderRanges(lines, ranges, T.messages.lines_omitted),
    usage: res.usage,
  };
}
