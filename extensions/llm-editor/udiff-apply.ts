/** In-house unified-hunk matcher and atomic string applier. */

import type { UdiffHunk, UdiffRow } from "./udiff.ts";
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

/**
 * Context-fuzz ladder, patch(1)'s fuzz factor. Tried in order only after the
 * full pattern matches nowhere; each level drops that many outer context rows,
 * never a `+`/`-` row, so the change itself is never inferred — only the proof
 * of its location is weakened, and a unique match is still required.
 *
 * Unlike patch(1) these hunks are model-authored, so a mismatched context row
 * is not stale ground truth but evidence the model mis-modeled the file — and
 * dropping it discards that evidence. Every dropped row is therefore verified
 * against the file line it would have covered (`recognizable`): fuzz tolerates
 * a boundary the model got approximately right, never one it invented.
 */
const FUZZ_LEVELS: readonly (readonly [number, number])[] = [
  [0, 1],
  [1, 0],
  [0, 2],
  [1, 1],
  [2, 0],
];

function trimmable(row: UdiffRow): boolean {
  return (
    row.operation === "context" &&
    !row.sourceNoNewline &&
    !row.targetNoNewline
  );
}

/** The hunk with `lead`/`tail` outer context rows dropped, or null if it cannot be. */
function fuzzHunk(
  hunk: UdiffHunk,
  lead: number,
  tail: number,
): UdiffHunk | null {
  if (lead + tail >= hunk.rows.length) return null;
  for (let index = 0; index < lead; index++)
    if (!trimmable(hunk.rows[index])) return null;
  for (let index = 0; index < tail; index++)
    if (!trimmable(hunk.rows[hunk.rows.length - 1 - index])) return null;
  const rows = hunk.rows.slice(lead, hunk.rows.length - tail);
  const oldCount = rows.filter((row) => row.operation !== "add").length;
  // Without a source row there is nothing left to locate the hunk by.
  if (oldCount === 0) return null;
  return {
    ...hunk,
    rows,
    oldCount,
    newCount: rows.filter((row) => row.operation !== "delete").length,
    // Every trimmed leading row was a context row, so the anchor moves with them.
    oldStart: hunk.anchored ? hunk.oldStart + lead : 0,
  };
}

/**
 * Whether a dropped context row is still recognizable in the file line it
 * covered: both non-blank, sharing a common prefix or suffix, and differing only
 * in a short middle — two characters outright, or a quarter of the line.
 *
 * `  }` against `  },`, or a row where the model silently corrected the prose it
 * was copying (`lookup has` for `lookup have`), is a boundary it got
 * approximately right. A closing fence against a blank line is one it invented.
 */
function recognizable(dropped: string, file: string): boolean {
  const left = dropped.trim();
  const right = file.trim();
  if (left === "" || right === "") return false;
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < left.length - prefix &&
    suffix < right.length - prefix &&
    left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  )
    suffix++;
  const common = prefix + suffix;
  const differing = left.length + right.length - 2 * common;
  if (common === 0) return false;
  return differing <= 2 || differing * 4 <= Math.max(left.length, right.length);
}

/** Verify every row `fuzzHunk` dropped against the file lines it covered. */
function boundaryHolds(
  lines: SourceLine[],
  hunk: UdiffHunk,
  match: HunkMatch,
  lead: number,
  tail: number,
): boolean {
  for (let index = 0; index < lead; index++) {
    const line = lines[match.startLine - lead + index];
    if (!line || !recognizable(hunk.rows[index].text, line.text)) return false;
  }
  for (let index = 0; index < tail; index++) {
    const row = hunk.rows[hunk.rows.length - tail + index];
    const line = lines[match.endLine + index];
    if (!line || !recognizable(row.text, line.text)) return false;
  }
  return true;
}

/** The hunk's source rows: one contiguous run of file lines it must cover. */
function pattern(hunk: UdiffHunk): PatternLine[] {
  const lines: PatternLine[] = [];
  for (let row = 0; row < hunk.rows.length; row++)
    if (hunk.rows[row].operation !== "add")
      lines.push({ row, text: hunk.rows[row].text });
  return lines;
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

function matchAt(
  lines: SourceLine[],
  hunk: UdiffHunk,
  start: number,
  mode: "exact" | "fuzzy",
  budget: MatchBudget,
): MatchAttempt {
  const source = pattern(hunk);
  const limit = start + source.length;
  if (start < 0 || limit > lines.length) return { kind: "miss" };
  const rows = new Map<number, number>();
  let indentAdd: string | undefined;
  for (let index = 0; index < source.length; index++) {
    if (budget.remaining-- <= 0) {
      budget.exhausted = true;
      return { kind: "limit" };
    }
    const file = lines[start + index].text;
    if (mode === "exact") {
      if (file !== source[index].text) return { kind: "miss" };
    } else {
      const next = fuzzyLine(file, source[index].text, indentAdd);
      if (next === null) return { kind: "miss" };
      indentAdd = next;
    }
    rows.set(source[index].row, start + index);
  }
  return {
    kind: "match",
    value: {
      startLine: start,
      endLine: limit,
      rows,
      indentAdd: indentAdd ?? "",
      mode,
    },
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

type Resolution = MatchAttempt | { kind: "bad_anchor" };

function resolveExact(
  lines: SourceLine[],
  hunk: UdiffHunk,
  fuzzy: boolean,
  budget: MatchBudget,
): Resolution {
  const sourceRows = hunk.rows.filter((row) => row.operation !== "add");
  if (sourceRows.length === 0) {
    // A pure insertion is placed solely by its coordinate, so a hunk whose
    // header carried none cannot be placed at all.
    if (!hunk.anchored || hunk.oldStart < 0 || hunk.oldStart > lines.length)
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
  if (hunk.anchored && anchor >= 0 && anchor < lines.length) {
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

/**
 * Resolve a hunk, escalating through the context-fuzz ladder on a total miss.
 * Returns the hunk that actually matched: a fuzzed hunk's rows are what the
 * resulting match indexes into, so the caller must splice from that one.
 */
function resolveHunk(
  lines: SourceLine[],
  hunk: UdiffHunk,
  fuzzy: boolean,
  budget: MatchBudget,
): { attempt: Resolution; hunk: UdiffHunk } {
  const attempt = resolveExact(lines, hunk, fuzzy, budget);
  if (attempt.kind !== "miss" || !fuzzy) return { attempt, hunk };
  for (const [lead, tail] of FUZZ_LEVELS) {
    const candidate = fuzzHunk(hunk, lead, tail);
    if (!candidate) continue;
    const retry = resolveExact(lines, candidate, fuzzy, budget);
    if (retry.kind === "miss") continue;
    if (retry.kind === "match" && !boundaryHolds(lines, hunk, retry.value, lead, tail))
      continue;
    return { attempt: retry, hunk: candidate };
  }
  return { attempt, hunk };
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
  for (const original of hunks) {
    const { attempt, hunk } = resolveHunk(lines, original, fuzzy, budget);
    if (attempt.kind === "bad_anchor")
      return { ok: false, error: { code: "bad_anchor", block: hunk.block } };
    if (attempt.kind === "ambiguous")
      return { ok: false, error: { code: "ambiguous", block: hunk.block } };
    if (attempt.kind === "limit")
      return { ok: false, error: { code: "work_limit", block: hunk.block } };
    if (attempt.kind === "miss")
      return {
        ok: false,
        error: { code: "not_found", block: hunk.block, fuzzy },
      };
    const intent = newlineIntent(hunk, attempt.value, lines);
    if (intent === false || (intent && newline && intent !== newline))
      return { ok: false, error: { code: "bad_newline", block: hunk.block } };
    if (intent) newline = intent;
    anyFuzzy ||= attempt.value.mode === "fuzzy" || hunk !== original;
    splices.push(...changeSplices(content, lines, hunk, attempt.value, eol));
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
