/**
 * Bounded, forgiving parser for llm-editor's single-file unified-diff dialect.
 *
 * Permissiveness policy: normalize whatever has exactly one reading, reject
 * whatever does not. A model that writes several hunks in one array element,
 * miscounts a header, wraps the patch in a fence, or drops the diff-prefix
 * space from a row has still expressed one unambiguous edit, so the
 * parser repairs it instead of failing the whole tool call. Anything that would
 * require guessing intent (missing context rows) still fails loudly — a wrong
 * patch is worse than a retry.
 */

export const MAX_DIFF_BLOCKS = 64;
export const MAX_DIFF_BLOCK_BYTES = 262_144;
export const MAX_DIFF_TOTAL_BYTES = 524_288;
export const MAX_DIFF_LINES = 20_000;
export const MAX_DIFF_COORDINATE = 1_000_000;

export type UdiffOperation = "context" | "delete" | "add";

export interface UdiffRow {
  operation: UdiffOperation;
  text: string;
  sourceNoNewline: boolean;
  targetNoNewline: boolean;
}

export interface UdiffHunk {
  block: number;
  /** False when the header carried no coordinates; `oldStart` is then unusable. */
  anchored: boolean;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: UdiffRow[];
}

export type UdiffParseErrorCode =
  | "no_diffs"
  | "too_many"
  | "too_large"
  | "bad_block"
  | "bad_header"
  | "no_changes"
  | "bad_count"
  | "bad_newline";

export interface UdiffParseError {
  code: UdiffParseErrorCode;
  block?: number;
  line?: number;
}

export type UdiffParseResult =
  | { ok: true; hunks: UdiffHunk[] }
  | { ok: false; error: UdiffParseError };

const HEADER = /^@@+ *-(\d+)(?:,(\d+))? *\+(\d+)(?:,(\d+))? *@@+(?: .*)?$/;
/**
 * A coordinate-less hunk separator: `@@`, `@@ @@`, `@@ ... @@ trailing`, or the
 * bare `***` of the apply_patch dialect. Models use these to divide hunks inside
 * one element, and a malformed `@@` line degrades to this. The resulting hunk is
 * unanchored, and an empty one (a trailing end-marker) is simply dropped. Only
 * tried after HEADER, which it would otherwise shadow.
 */
const HEADER_LOOSE = /^(?:@@+(?: *(?:\.\.\.)? *@@+)?(?: .*)?|\*\*\*)$/;
/**
 * Envelope lines models wrap a patch in: Markdown fences, and the codex
 * `apply_patch` markers (`*** Begin Patch`, `*** Update File: p`, `*** End
 * Patch`). Unprefixed only — a fence or `***` belonging to the edited file
 * carries a diff prefix and is never matched here.
 */
const WRAPPER = /^(?:```|~~~|\*\*\* )/;
const NO_NEWLINE = /^\\ No newline at end of (?:file|source|target)[ \t]*$/;

function fail(
  code: UdiffParseErrorCode,
  block?: number,
  line?: number,
): UdiffParseResult {
  return { ok: false, error: { code, block, line } };
}

function logicalLines(diff: string): string[] {
  const normalized = diff.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Classify one body line.
 *
 * A line with no diff prefix is read as context. Models routinely drop the
 * prefix space on rows that start at column 0 while every neighbour is
 * indented, visually aligning the diff. Context is the only reading that can
 * be wrong without corrupting the file: a misread row cannot delete or insert
 * anything, it can only fail to match, which surfaces as a located error.
 */
function classify(line: string): UdiffRow {
  const prefix = line[0];
  const bare = prefix !== " " && prefix !== "-" && prefix !== "+";
  const operation: UdiffOperation =
    prefix === "-" ? "delete" : prefix === "+" ? "add" : "context";
  const text = bare ? line : line.slice(1);
  return { operation, text, sourceNoNewline: false, targetNoNewline: false };
}

interface HunkParse {
  hunk?: UdiffHunk;
  error?: UdiffParseError;
}

/**
 * Parse one hunk header plus its body rows. `base` is the header's line number;
 * a null `header` is a coordinate-less `@@`, which yields an unanchored hunk the
 * applier must locate by unique content match.
 */
function parseHunk(
  header: RegExpExecArray | null,
  body: string[],
  block: number,
  base: number,
): HunkParse {
  const bad = (
    code: UdiffParseErrorCode,
    line?: number,
  ): HunkParse => ({ error: { code, block, line } });

  const anchored = header !== null;
  const oldStart = anchored ? Number(header[1]) : 0;
  const newStart = anchored ? Number(header[3]) : 0;
  const headerOldCount = !anchored
    ? 0
    : header[2] === undefined
      ? 1
      : Number(header[2]);
  const headerNewCount = !anchored
    ? 0
    : header[4] === undefined
      ? 1
      : Number(header[4]);
  const coordinates = [oldStart, headerOldCount, newStart, headerNewCount];
  if (
    coordinates.some(
      (value) => !Number.isSafeInteger(value) || value > MAX_DIFF_COORDINATE,
    )
  )
    return bad("bad_header", base);
  if (headerOldCount > 0 && oldStart < 1) return bad("bad_header", base);
  if (headerNewCount > 0 && newStart < 1) return bad("bad_header", base);

  const rows: UdiffRow[] = [];
  let changed = false;
  let sourceCount = 0;
  let targetCount = 0;
  for (let index = 0; index < body.length; index++) {
    const line = body[index];
    const at = base + index + 1;
    if (NO_NEWLINE.test(line)) {
      const previous = rows.at(-1);
      if (!previous) return bad("bad_newline", at);
      if (previous.operation !== "add") {
        if (previous.sourceNoNewline) return bad("bad_newline", at);
        previous.sourceNoNewline = true;
      }
      if (previous.operation !== "delete") {
        if (previous.targetNoNewline) return bad("bad_newline", at);
        previous.targetNoNewline = true;
      }
      continue;
    }
    const row = classify(line);
    rows.push(row);
    if (row.operation !== "add") sourceCount++;
    if (row.operation !== "delete") targetCount++;
    if (row.operation !== "context") changed = true;
  }

  // A hunk that changes nothing is dropped, not fatal: it costs the caller
  // nothing to ignore, and one stray no-op must not sink its siblings.
  if (!changed) return {};

  // Header counts are advisory: the body is the authority on how many source
  // and target lines a hunk covers. The one thing the body cannot supply is a
  // context row the model dropped, so a header claiming source lines the body
  // lacks stays fatal rather than becoming a blind insertion.
  if (sourceCount === 0 && headerOldCount > 0) return bad("bad_count", base);

  const sourceMarked = rows.filter((row) => row.sourceNoNewline);
  const targetMarked = rows.filter((row) => row.targetNoNewline);
  let lastSource: UdiffRow | undefined;
  let lastTarget: UdiffRow | undefined;
  for (const row of rows) {
    if (row.operation !== "add") lastSource = row;
    if (row.operation !== "delete") lastTarget = row;
  }
  if (
    sourceMarked.length > 1 ||
    targetMarked.length > 1 ||
    (sourceMarked.length === 1 && sourceMarked[0] !== lastSource) ||
    (targetMarked.length === 1 && targetMarked[0] !== lastTarget)
  )
    return bad("bad_newline");

  return {
    hunk: {
      block,
      anchored,
      oldStart,
      oldCount: sourceCount,
      newStart,
      newCount: targetCount,
      rows,
    },
  };
}

/**
 * Parse one array element, which may hold several hunks.
 *
 * Everything before the first `@@` (fences, `diff --git`, `---`/`+++` headers,
 * prose) is dropped the way patch(1) drops it; WRAPPER lines are dropped
 * wherever they appear.
 */
function parseBlock(diff: string, block: number): UdiffParseResult {
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BLOCK_BYTES)
    return fail("too_large", block);
  const lines = logicalLines(diff).filter((line) => !WRAPPER.test(line));
  if (lines.length === 0) return fail("bad_block", block, 1);
  if (lines.length > MAX_DIFF_LINES) return fail("too_large", block);

  const headers: { match: RegExpExecArray | null; at: number }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const match = HEADER.exec(lines[index]);
    if (match) headers.push({ match, at: index });
    else if (HEADER_LOOSE.test(lines[index]))
      headers.push({ match: null, at: index });
  }
  if (headers.length === 0) return fail("bad_header", block, 1);

  const hunks: UdiffHunk[] = [];
  for (let index = 0; index < headers.length; index++) {
    const start = headers[index].at;
    const end = headers[index + 1]?.at ?? lines.length;
    const parsed = parseHunk(
      headers[index].match,
      lines.slice(start + 1, end),
      block,
      start + 1,
    );
    if (parsed.error) return { ok: false, error: parsed.error };
    if (parsed.hunk) hunks.push(parsed.hunk);
  }
  return { ok: true, hunks };
}

/** Parse every completion diff before any matching or file mutation occurs. */
export function parseUdiffs(raw: unknown): UdiffParseResult {
  if (!Array.isArray(raw) || raw.length === 0) return fail("no_diffs");
  if (raw.length > MAX_DIFF_BLOCKS) return fail("too_many");
  let total = 0;
  const hunks: UdiffHunk[] = [];
  for (let index = 0; index < raw.length; index++) {
    if (typeof raw[index] !== "string") return fail("bad_block", index + 1);
    total += Buffer.byteLength(raw[index], "utf8");
    if (total > MAX_DIFF_TOTAL_BYTES) return fail("too_large", index + 1);
    const parsed = parseBlock(raw[index], index + 1);
    if (!parsed.ok) return parsed;
    hunks.push(...parsed.hunks);
  }
  if (hunks.length === 0) return fail("no_changes", 1);
  if (hunks.length > MAX_DIFF_BLOCKS) return fail("too_many", 1);
  return { ok: true, hunks };
}
