/** In-house unified-hunk matcher and atomic string applier. */

import type { UdiffHunk } from "./udiff.ts";
import {
  changeSplices,
  conflicts,
  dominantEol,
  newlineIntent,
  splitSource,
  type HunkMatch,
  type NewlineIntent,
  type SourceLine,
  type Splice,
} from "./udiff-splice.ts";

interface PatternLine {
  row: number;
  text: string;
}
export type UdiffApplyError =
  | { code: "bad_anchor"; block: number }
  | { code: "not_found"; block: number; fuzzy: boolean }
  | { code: "ambiguous"; block: number }
  | { code: "bad_newline"; block: number }
  | { code: "work_limit"; block: number }
  | { code: "overlap"; block: number; previous: number };

export type UdiffApplyResult =
  | {
      ok: true;
      content: string;
      applied: number;
      wholeFileRewrite: boolean;
      match: "exact" | "fuzzy";
    }
  | { ok: false; error: UdiffApplyError };

type MatchAttempt =
  | { kind: "match"; value: HunkMatch }
  | { kind: "miss" }
  | { kind: "ambiguous" }
  | { kind: "limit" };

interface MatchBudget {
  remaining: number;
  exhausted: boolean;
}

const MAX_MATCH_WORK = 5_000_000;

function patternSegments(hunk: UdiffHunk): PatternLine[][] {
  const segments: PatternLine[][] = [[]];
  for (let row = 0; row < hunk.rows.length; row++) {
    const item = hunk.rows[row];
    if (item.elision) segments.push([]);
    else if (item.operation !== "add")
      segments.at(-1)?.push({ row, text: item.text });
  }
  return segments;
}

function leadingWhitespace(text: string): string {
  return /^[ \t]*/.exec(text)?.[0] ?? "";
}

function fuzzyLine(
  file: string,
  patch: string,
  indentAdd: string | undefined,
): string | null {
  if (file.trimEnd() === "" || patch.trimEnd() === "")
    return file.trimEnd() === "" && patch.trimEnd() === ""
      ? (indentAdd ?? "")
      : null;
  const fileLead = leadingWhitespace(file);
  const patchLead = leadingWhitespace(patch);
  if (!fileLead.endsWith(patchLead)) return null;
  if (
    file.slice(fileLead.length).trimEnd() !==
    patch.slice(patchLead.length).trimEnd()
  )
    return null;
  const candidate = fileLead.slice(0, fileLead.length - patchLead.length);
  return indentAdd === undefined || indentAdd === candidate ? candidate : null;
}

function matchSegment(
  lines: SourceLine[],
  segment: PatternLine[],
  start: number,
  mode: "exact" | "fuzzy",
  indentAdd: string | undefined,
  budget: MatchBudget,
): { rows: Map<number, number>; indentAdd: string } | null {
  if (start < 0 || start + segment.length > lines.length) return null;
  const rows = new Map<number, number>();
  let add = indentAdd;
  for (let index = 0; index < segment.length; index++) {
    if (budget.remaining-- <= 0) {
      budget.exhausted = true;
      return null;
    }
    const pattern = segment[index];
    const file = lines[start + index].text;
    if (mode === "exact") {
      if (file !== pattern.text) return null;
    } else {
      const next = fuzzyLine(file, pattern.text, add);
      if (next === null) return null;
      add = next;
    }
    rows.set(pattern.row, start + index);
  }
  return { rows, indentAdd: add ?? "" };
}

function matchAt(
  lines: SourceLine[],
  hunk: UdiffHunk,
  start: number,
  mode: "exact" | "fuzzy",
  budget: MatchBudget,
): MatchAttempt {
  const segments = patternSegments(hunk);
  const limit = start + hunk.oldCount;
  if (limit > lines.length) return { kind: "miss" };
  const first = matchSegment(
    lines,
    segments[0],
    start,
    mode,
    undefined,
    budget,
  );
  if (!first) return { kind: budget.exhausted ? "limit" : "miss" };
  const rows = first.rows;
  let indentAdd = first.indentAdd;
  let cursor = start + segments[0].length;
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    let found: ReturnType<typeof matchSegment> = null;
    let foundAt = -1;
    const last = segmentIndex === segments.length - 1;
    const firstStart = last ? limit - segment.length : cursor + 1;
    const lastStart = limit - segment.length;
    for (let index = firstStart; index <= lastStart; index++) {
      if (index <= cursor) continue;
      const candidate = matchSegment(
        lines,
        segment,
        index,
        mode,
        indentAdd,
        budget,
      );
      if (!candidate) {
        if (budget.exhausted) return { kind: "limit" };
        continue;
      }
      if (found) return { kind: "ambiguous" };
      found = candidate;
      foundAt = index;
    }
    if (!found) return { kind: "miss" };
    for (const [row, line] of found.rows) rows.set(row, line);
    indentAdd = found.indentAdd;
    cursor = foundAt + segment.length;
  }
  if (cursor !== limit) return { kind: "miss" };
  return {
    kind: "match",
    value: { startLine: start, endLine: limit, rows, indentAdd, mode },
  };
}

function searchAll(
  lines: SourceLine[],
  hunk: UdiffHunk,
  mode: "exact" | "fuzzy",
  budget: MatchBudget,
): MatchAttempt {
  let found: HunkMatch | undefined;
  for (let start = 0; start + hunk.oldCount <= lines.length; start++) {
    const attempt = matchAt(lines, hunk, start, mode, budget);
    if (attempt.kind === "ambiguous" || attempt.kind === "limit")
      return attempt;
    if (attempt.kind !== "match") continue;
    if (found) return { kind: "ambiguous" };
    found = attempt.value;
  }
  return found ? { kind: "match", value: found } : { kind: "miss" };
}

function resolveHunk(
  lines: SourceLine[],
  hunk: UdiffHunk,
  fuzzy: boolean,
  budget: MatchBudget,
): MatchAttempt | { kind: "bad_anchor" } {
  const sourceRows = hunk.rows.filter(
    (row) => row.operation !== "add" && !row.elision,
  );
  if (sourceRows.length === 0) {
    if (hunk.oldStart < 0 || hunk.oldStart > lines.length)
      return { kind: "bad_anchor" };
    return {
      kind: "match",
      value: {
        startLine: hunk.oldStart,
        endLine: hunk.oldStart,
        rows: new Map(),
        indentAdd: "",
        mode: "exact",
      },
    };
  }

  const anchor = hunk.oldStart - 1;
  if (anchor >= 0 && anchor < lines.length) {
    const exact = matchAt(lines, hunk, anchor, "exact", budget);
    if (exact.kind !== "miss") return exact;
    if (fuzzy) {
      const fuzzyMatch = matchAt(lines, hunk, anchor, "fuzzy", budget);
      if (fuzzyMatch.kind !== "miss") return fuzzyMatch;
    }
  }
  const exact = searchAll(lines, hunk, "exact", budget);
  if (exact.kind !== "miss" || !fuzzy) return exact;
  return searchAll(lines, hunk, "fuzzy", budget);
}

/** Resolve every hunk against the immutable original, then apply all or none. */
export function applyUdiffs(
  content: string,
  hunks: UdiffHunk[],
  opts?: { fuzzy?: boolean },
): UdiffApplyResult {
  const lines = splitSource(content);
  const eol = dominantEol(lines);
  const splices: Splice[] = [];
  const fuzzy = opts?.fuzzy !== false;
  let anyFuzzy = false;
  let newline: NewlineIntent | undefined;
  const budget: MatchBudget = { remaining: MAX_MATCH_WORK, exhausted: false };
  for (const hunk of hunks) {
    const resolved = resolveHunk(lines, hunk, fuzzy, budget);
    if (resolved.kind === "bad_anchor")
      return { ok: false, error: { code: "bad_anchor", block: hunk.block } };
    if (resolved.kind === "ambiguous")
      return { ok: false, error: { code: "ambiguous", block: hunk.block } };
    if (resolved.kind === "limit")
      return { ok: false, error: { code: "work_limit", block: hunk.block } };
    if (resolved.kind === "miss")
      return {
        ok: false,
        error: { code: "not_found", block: hunk.block, fuzzy },
      };
    const intent = newlineIntent(hunk, resolved.value, lines);
    if (intent === false || (intent && newline && intent !== newline))
      return { ok: false, error: { code: "bad_newline", block: hunk.block } };
    if (intent) newline = intent;
    anyFuzzy ||= resolved.value.mode === "fuzzy";
    splices.push(...changeSplices(content, lines, hunk, resolved.value, eol));
  }

  splices.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  for (let index = 1; index < splices.length; index++)
    if (conflicts(splices[index - 1], splices[index]))
      return {
        ok: false,
        error: {
          code: "overlap",
          block: splices[index].block,
          previous: splices[index - 1].block,
        },
      };

  let output = content;
  for (let index = splices.length - 1; index >= 0; index--) {
    const splice = splices[index];
    output =
      output.slice(0, splice.start) + splice.text + output.slice(splice.end);
  }
  if (newline === "add" && !output.endsWith("\n")) output += eol;
  if (newline === "remove" && output.endsWith("\n"))
    output = output.slice(0, output.endsWith("\r\n") ? -2 : -1);
  return {
    ok: true,
    content: output,
    applied: hunks.length,
    wholeFileRewrite:
      splices.length === 1 &&
      splices[0].start === 0 &&
      splices[0].end === content.length,
    match: anyFuzzy ? "fuzzy" : "exact",
  };
}
