import type { UdiffHunk, UdiffRow } from "./udiff.ts";
import type { HunkMatch, SourceLine } from "./udiff-splice.ts";

interface PatternLine {
  row: number;
  text: string;
}
type MatchAttempt =
  | { kind: "match"; value: HunkMatch }
  | { kind: "miss" }
  | { kind: "ambiguous" }
  | { kind: "limit" };

export interface MatchBudget {
  remaining: number;
  exhausted: boolean;
}

export const MAX_MATCH_WORK = 5_000_000;

/**
 * Context-fuzz ladder, patch(1)'s fuzz factor, tried only after a full
 * pattern miss: each level drops that many outer context rows, never a
 * `+`/`-` row — the change itself is never inferred, only its location
 * weakened, and a unique match is still required. Hunks are model-authored,
 * so every dropped row is verified against the file line it covered
 * (`recognizable`): fuzz tolerates a boundary the model got approximately
 * right, never one it invented.
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
    row.operation === "context" && !row.sourceNoNewline && !row.targetNoNewline
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
 * A dropped context row must stay recognizable in the file line it covered:
 * both non-blank, sharing a common prefix or suffix, differing only in a
 * short middle — two characters outright, or a quarter of the line. A
 * closing fence against a blank line is one the model invented.
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
  from = 0,
): MatchAttempt {
  let found: HunkMatch | undefined;
  for (let start = from; start + hunk.oldCount <= lines.length; start++) {
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
  from: number,
): Resolution {
  const sourceRows = hunk.rows.filter((row) => row.operation !== "add");
  if (sourceRows.length === 0) {
    // A scoped insertion goes immediately after its resolved context line.
    if ((!hunk.anchored && from === 0) || from > lines.length)
      return { kind: "bad_anchor" };
    const at = hunk.anchored ? hunk.oldStart : from;
    if (at < from || at < 0 || at > lines.length) return { kind: "bad_anchor" };
    return {
      kind: "match",
      value: {
        startLine: at,
        endLine: at,
        rows: new Map(),
        indentAdd: "",
        mode: "exact",
      },
    };
  }

  const anchor = hunk.oldStart - 1;
  if (hunk.anchored && anchor >= from && anchor < lines.length) {
    const exact = matchAt(lines, hunk, anchor, "exact", budget);
    if (exact.kind !== "miss") return exact;
    if (fuzzy) {
      const fuzzyMatch = matchAt(lines, hunk, anchor, "fuzzy", budget);
      if (fuzzyMatch.kind !== "miss") return fuzzyMatch;
    }
  }
  const exact = searchAll(lines, hunk, "exact", budget, from);
  if (exact.kind !== "miss" || !fuzzy) return exact;
  return searchAll(lines, hunk, "fuzzy", budget, from);
}

/** Escalate through the fuzz ladder on a total miss; splice from the hunk that actually matched. */
function resolveHunk(
  lines: SourceLine[],
  hunk: UdiffHunk,
  fuzzy: boolean,
  budget: MatchBudget,
  from: number,
): { attempt: Resolution; hunk: UdiffHunk } {
  const attempt = resolveExact(lines, hunk, fuzzy, budget, from);
  if (attempt.kind !== "miss" || !fuzzy) return { attempt, hunk };
  for (const [lead, tail] of FUZZ_LEVELS) {
    const candidate = fuzzHunk(hunk, lead, tail);
    if (!candidate) continue;
    const retry = resolveExact(lines, candidate, fuzzy, budget, from + lead);
    if (retry.kind === "miss") continue;
    if (
      retry.kind === "match" &&
      !boundaryHolds(lines, hunk, retry.value, lead, tail)
    )
      continue;
    return { attempt: retry, hunk: candidate };
  }
  return { attempt, hunk };
}

function scopeStart(
  lines: SourceLine[],
  text: string,
  from: number,
  budget: MatchBudget,
): number | "ambiguous" | "limit" {
  let found = -1;
  for (let index = from; index < lines.length; index++) {
    if (budget.remaining-- <= 0) return "limit";
    if (lines[index].text !== text) continue;
    if (found >= 0) return "ambiguous";
    found = index;
  }
  return found < 0 ? -1 : found + 1;
}

export function locateHunk(
  lines: SourceLine[],
  original: UdiffHunk,
  fuzzy: boolean,
  budget: MatchBudget,
  from: number,
): { attempt: Resolution; hunk: UdiffHunk; scoped: boolean } {
  const scoped = original.scope !== undefined;
  if (budget.remaining <= 0) {
    budget.exhausted = true;
    return { attempt: { kind: "limit" }, hunk: original, scoped };
  }
  if (original.scope) {
    const scope = scopeStart(lines, original.scope, from, budget);
    if (scope === "ambiguous" || scope === "limit")
      return { attempt: { kind: scope }, hunk: original, scoped };
    if (scope < 0) return { attempt: { kind: "miss" }, hunk: original, scoped };
    from = scope;
  }
  return { ...resolveHunk(lines, original, fuzzy, budget, from), scoped };
}
