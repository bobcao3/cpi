import type { UdiffHunk } from "./udiff.ts";
import {
  changeSplices,
  conflicts,
  dominantEol,
  newlineIntent,
  splitSource,
  type NewlineIntent,
  type Splice,
} from "./udiff-splice.ts";
import { MAX_MATCH_WORK, locateHunk } from "./udiff-match.ts";

export type UdiffApplyError = Pick<UdiffHunk, "block" | "hunk" | "line"> &
  (
    | { code: "bad_anchor" | "ambiguous" | "bad_newline" | "work_limit" }
    | { code: "not_found"; fuzzy: boolean }
    | { code: "overlap"; previous: number }
  );

export type UdiffApplyResult =
  | {
      ok: true;
      content: string;
      applied: number;
      appliedHunks: number[];
      wholeFileRewrite: boolean;
      match: "exact" | "fuzzy";
      failure?: UdiffApplyError;
    }
  | { ok: false; error: UdiffApplyError };

export function applyUdiffs(
  content: string,
  hunks: UdiffHunk[],
  opts?: { fuzzy?: boolean; partial?: boolean },
): UdiffApplyResult {
  const lines = splitSource(content);
  const eol = dominantEol(lines);
  const splices: Splice[] = [];
  const appliedHunks: number[] = [];
  const fuzzy = opts?.fuzzy !== false;
  let anyFuzzy = false;
  let newline: NewlineIntent | undefined;
  const budget = { remaining: MAX_MATCH_WORK, exhausted: false };
  let cursor = 0;
  let scoped = false;
  let failure: UdiffApplyError | undefined;

  for (const original of hunks) {
    const location = {
      block: original.block,
      hunk: original.hunk,
      line: original.line,
    };
    const located = locateHunk(
      lines,
      original,
      fuzzy,
      budget,
      scoped ? cursor : 0,
    );
    const { attempt, hunk } = located;
    scoped ||= located.scoped;
    if (attempt.kind !== "match") {
      const code =
        attempt.kind === "miss"
          ? "not_found"
          : attempt.kind === "limit"
            ? "work_limit"
            : attempt.kind;
      failure = { ...location, code, fuzzy };
      break;
    }
    const intent = newlineIntent(hunk, attempt.value, lines);
    if (intent === false || (intent && newline && intent !== newline)) {
      failure = { ...location, code: "bad_newline" };
      break;
    }
    const changes = changeSplices(content, lines, hunk, attempt.value, eol);
    for (const change of changes) {
      const previous = splices.find((splice) => {
        if (budget.remaining-- <= 0) {
          budget.exhausted = true;
          return true;
        }
        return splice.start <= change.start
          ? conflicts(splice, change)
          : conflicts(change, splice);
      });
      if (budget.exhausted) {
        failure = { ...location, code: "work_limit" };
        break;
      }
      if (previous) {
        failure = { ...location, code: "overlap", previous: previous.hunk };
        break;
      }
    }
    if (failure) break;
    if (intent) newline = intent;
    anyFuzzy ||= attempt.value.mode === "fuzzy" || hunk !== original;
    splices.push(...changes);
    if (changes.length) appliedHunks.push(original.hunk);
    if (hunk.rows.every((row) => row.operation === "context")) scoped = true;
    if (scoped) cursor = attempt.value.endLine;
  }

  if (failure && (!opts?.partial || appliedHunks.length === 0))
    return { ok: false, error: failure };
  splices.sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
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
    applied: appliedHunks.length,
    appliedHunks,
    wholeFileRewrite:
      splices.length === 1 &&
      splices[0].start === 0 &&
      splices[0].end === content.length,
    match: anyFuzzy ? "fuzzy" : "exact",
    failure,
  };
}
