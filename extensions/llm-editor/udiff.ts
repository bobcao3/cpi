/** Strict, bounded parser for llm-editor's single-file unified-diff dialect. */

export const MAX_DIFF_BLOCKS = 64;
export const MAX_DIFF_BLOCK_BYTES = 262_144;
export const MAX_DIFF_TOTAL_BYTES = 524_288;
export const MAX_DIFF_LINES = 20_000;
export const MAX_DIFF_COORDINATE = 1_000_000;

export type UdiffOperation = "context" | "delete" | "add";

export interface UdiffRow {
  operation: UdiffOperation;
  text: string;
  /** A context-only `...` line that preserves an omitted source span. */
  elision: boolean;
  sourceNoNewline: boolean;
  targetNoNewline: boolean;
}

export interface UdiffHunk {
  block: number;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: UdiffRow[];
  hasElision: boolean;
}

export type UdiffParseErrorCode =
  | "no_diffs"
  | "too_many"
  | "too_large"
  | "bad_block"
  | "bad_header"
  | "multiple_hunks"
  | "bad_prefix"
  | "no_changes"
  | "bad_count"
  | "bad_elision"
  | "bad_newline";

export interface UdiffParseError {
  code: UdiffParseErrorCode;
  block?: number;
  line?: number;
}

export type UdiffParseResult =
  | { ok: true; hunks: UdiffHunk[] }
  | { ok: false; error: UdiffParseError };

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const ELISION = /^[ \t]*\.\.\.[ \t]*$/;
const NO_NEWLINE = "\\ No newline at end of file";

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

/** Parse one array element. Each element must contain exactly one hunk. */
function parseBlock(diff: string, block: number): UdiffParseResult {
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_BLOCK_BYTES)
    return fail("too_large", block);
  const lines = logicalLines(diff);
  if (lines.length === 0) return fail("bad_block", block, 1);
  if (lines.length > MAX_DIFF_LINES) return fail("too_large", block);

  const match = HEADER.exec(lines[0]);
  if (!match) return fail("bad_header", block, 1);
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  const coordinates = [oldStart, oldCount, newStart, newCount];
  if (
    coordinates.some(
      (value) => !Number.isSafeInteger(value) || value > MAX_DIFF_COORDINATE,
    )
  )
    return fail("bad_header", block, 1);
  if (oldCount > 0 && oldStart < 1) return fail("bad_header", block, 1);
  if (newCount > 0 && newStart < 1) return fail("bad_header", block, 1);

  const rows: UdiffRow[] = [];
  let changed = false;
  let sourceCount = 0;
  let targetCount = 0;
  let hasElision = false;
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("@@ ")) return fail("multiple_hunks", block, index + 1);
    if (line === NO_NEWLINE) {
      const previous = rows.at(-1);
      if (!previous || previous.elision)
        return fail("bad_newline", block, index + 1);
      if (previous.operation !== "add") {
        if (previous.sourceNoNewline)
          return fail("bad_newline", block, index + 1);
        previous.sourceNoNewline = true;
      }
      if (previous.operation !== "delete") {
        if (previous.targetNoNewline)
          return fail("bad_newline", block, index + 1);
        previous.targetNoNewline = true;
      }
      continue;
    }
    const prefix = line[0];
    if (prefix !== " " && prefix !== "-" && prefix !== "+")
      return fail("bad_prefix", block, index + 1);
    const operation: UdiffOperation =
      prefix === " " ? "context" : prefix === "-" ? "delete" : "add";
    const text = line.slice(1);
    const elision = operation === "context" && ELISION.test(text);
    rows.push({
      operation,
      text,
      elision,
      sourceNoNewline: false,
      targetNoNewline: false,
    });
    if (operation !== "add" && !elision) sourceCount++;
    if (operation !== "delete" && !elision) targetCount++;
    if (operation !== "context") changed = true;
    if (elision) hasElision = true;
  }

  if (!changed) return fail("no_changes", block);
  if (rows.length === 0) return fail("bad_block", block, 2);
  if (hasElision) {
    if (rows[0].elision || rows.at(-1)?.elision)
      return fail("bad_elision", block);
    let segmentSource = 0;
    for (let index = 0; index < rows.length; index++) {
      if (rows[index].elision) {
        if (segmentSource === 0) return fail("bad_elision", block, index + 2);
        segmentSource = 0;
      } else if (rows[index].operation !== "add") {
        segmentSource++;
      }
    }
    if (segmentSource === 0) return fail("bad_elision", block);
    const delta = targetCount - sourceCount;
    if (oldCount <= sourceCount || newCount !== oldCount + delta)
      return fail("bad_count", block, 1);
  } else if (sourceCount !== oldCount || targetCount !== newCount) {
    return fail("bad_count", block, 1);
  }
  if (sourceCount === 0 && rows.some((row) => row.operation !== "add"))
    return fail("bad_count", block, 1);
  const sourceMarked = rows.filter((row) => row.sourceNoNewline);
  const targetMarked = rows.filter((row) => row.targetNoNewline);
  let lastSource: UdiffRow | undefined;
  let lastTarget: UdiffRow | undefined;
  for (const row of rows) {
    if (row.operation !== "add" && !row.elision) lastSource = row;
    if (row.operation !== "delete" && !row.elision) lastTarget = row;
  }
  if (
    sourceMarked.length > 1 ||
    targetMarked.length > 1 ||
    (sourceMarked.length === 1 && sourceMarked[0] !== lastSource) ||
    (targetMarked.length === 1 && targetMarked[0] !== lastTarget)
  )
    return fail("bad_newline", block);

  return {
    ok: true,
    hunks: [
      { block, oldStart, oldCount, newStart, newCount, rows, hasElision },
    ],
  };
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
    hunks.push(parsed.hunks[0]);
  }
  return { ok: true, hunks };
}
