/** Lossless source-line handling and resolved unified-hunk splices. */

import type { UdiffHunk, UdiffRow } from "./udiff.ts";

export interface SourceLine {
  text: string;
  start: number;
  end: number;
  eol: string;
}

export interface HunkMatch {
  startLine: number;
  endLine: number;
  rows: Map<number, number>;
  indentAdd: string;
  mode: "exact" | "fuzzy";
}

export interface Splice {
  start: number;
  end: number;
  text: string;
  block: number;
}

export type NewlineIntent = "add" | "remove";

export function splitSource(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline < 0) {
      lines.push({
        text: content.slice(start),
        start,
        end: content.length,
        eol: "",
      });
      break;
    }
    const crlf = newline > start && content[newline - 1] === "\r";
    lines.push({
      text: content.slice(start, crlf ? newline - 1 : newline),
      start,
      end: newline + 1,
      eol: crlf ? "\r\n" : "\n",
    });
    start = newline + 1;
  }
  return lines;
}

export function dominantEol(lines: SourceLine[]): string {
  let lf = 0;
  let crlf = 0;
  for (const line of lines)
    line.eol === "\r\n" ? crlf++ : line.eol === "\n" ? lf++ : undefined;
  return crlf > lf ? "\r\n" : "\n";
}

function insertionLine(
  hunkRows: UdiffRow[],
  mapping: Map<number, number>,
  first: number,
  last: number,
  fallback: number,
): number {
  for (let row = first - 1; row >= 0; row--) {
    const line = mapping.get(row);
    if (line !== undefined) return line + 1;
  }
  for (let row = last + 1; row < hunkRows.length; row++) {
    const line = mapping.get(row);
    if (line !== undefined) return line;
  }
  return fallback;
}

function adjustedAdd(
  text: string,
  indentAdd: string,
  mode: "exact" | "fuzzy",
): string {
  if (mode === "exact" || indentAdd === "" || text.trim() === "") return text;
  return indentAdd + text;
}

export function changeSplices(
  content: string,
  lines: SourceLine[],
  hunk: UdiffHunk,
  match: HunkMatch,
  eolDefault: string,
): Splice[] {
  const splices: Splice[] = [];
  for (let row = 0; row < hunk.rows.length; row++) {
    if (hunk.rows[row].operation === "context") continue;
    const first = row;
    while (
      row + 1 < hunk.rows.length &&
      hunk.rows[row + 1].operation !== "context"
    )
      row++;
    const last = row;
    const deleted: number[] = [];
    const added: string[] = [];
    for (let index = first; index <= last; index++) {
      const item = hunk.rows[index];
      if (item.operation === "delete")
        deleted.push(match.rows.get(index) as number);
      else if (item.operation === "add")
        added.push(adjustedAdd(item.text, match.indentAdd, match.mode));
    }
    const lineStart = deleted.length
      ? deleted[0]
      : insertionLine(hunk.rows, match.rows, first, last, match.startLine);
    const lineEnd = deleted.length ? deleted.at(-1)! + 1 : lineStart;
    const start =
      lineStart < lines.length ? lines[lineStart].start : content.length;
    const end = lineEnd > lineStart ? lines[lineEnd - 1].end : start;
    const nearbyEol =
      lines[lineStart]?.eol || lines[lineStart - 1]?.eol || eolDefault;
    let text = added.join(nearbyEol);
    const touchesEnd = end === content.length;
    const originalEndsWithEol = content.endsWith("\n");
    if (added.length > 0 && (!touchesEnd || originalEndsWithEol))
      text += nearbyEol;
    if (
      !deleted.length &&
      lineStart === lines.length &&
      lines.at(-1)?.eol === ""
    )
      text = nearbyEol + text;
    splices.push({ start, end, text, block: hunk.block });
  }
  return splices;
}

export function newlineIntent(
  hunk: UdiffHunk,
  match: HunkMatch,
  lines: SourceLine[],
): NewlineIntent | false | undefined {
  let sourceMarked = false;
  let targetMarked = false;
  for (let row = 0; row < hunk.rows.length; row++) {
    const item = hunk.rows[row];
    if (item.sourceNoNewline) {
      const line = match.rows.get(row);
      if (
        line === undefined ||
        line !== lines.length - 1 ||
        lines[line].eol !== ""
      )
        return false;
      sourceMarked = true;
    }
    if (item.targetNoNewline) targetMarked = true;
  }
  if (targetMarked && match.endLine !== lines.length) return false;
  if (sourceMarked === targetMarked) return undefined;
  return sourceMarked ? "add" : "remove";
}

export function conflicts(previous: Splice, current: Splice): boolean {
  const previousEmpty = previous.start === previous.end;
  const currentEmpty = current.start === current.end;
  if (previousEmpty && currentEmpty) return previous.start === current.start;
  if (previousEmpty)
    return previous.start > current.start && previous.start < current.end;
  if (currentEmpty)
    return current.start > previous.start && current.start < previous.end;
  return previous.end > current.start;
}
