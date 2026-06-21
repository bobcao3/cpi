/**
 * Aider-style fuzzy SEARCH/REPLACE fallback for `apply.ts`.
 *
 * Engaged per-block ONLY when the exact match finds zero occurrences (a >1
 * count still errors `not_unique` — fuzzy never rescues ambiguity). Returns
 * char splices against the ORIGINAL content so the caller's atomic,
 * overlap-checked, back-to-front application is preserved (Aider instead mutates
 * sequentially; we keep cpi's stricter model). Two tolerances, in Aider order:
 *
 *   1. indent  — a uniform leading-whitespace shift between SEARCH and the file
 *                (model dropped/under-indented the whole block consistently).
 *                Re-indents REPLACE by the file's offset. Mirrors Aider's
 *                replace_part_with_missing_leading_whitespace (editblock_coder.py).
 *   2. ellipsis — `...` lines eliding unchanged code between edits in one block.
 *                Each non-`...` chunk must occur exactly once. Mirrors Aider's
 *                try_dotdotdots.
 *
 * Fuzzy always matches the FIRST candidate (Aider semantics); it does not
 * disambiguate. Pure leaf: no fs/pi/text imports.
 */

export interface Splice {
  start: number;
  end: number;
  text: string;
}

/** Split into lines keeping the trailing newline (Python splitlines(keepends=True)). "" → []. */
function keepLines(s: string): string[] {
  if (s === "") return [];
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      // '\n'; a preceding '\r' stays attached to this line (CRLF-safe)
      out.push(s.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out;
}

/** Leading space/tab count (code-leading whitespace; mirrors len(p)-len(p.lstrip()) for code lines). */
function leadLen(line: string): number {
  const m = /^[ \t]+/.exec(line);
  return m ? m[0].length : 0;
}

/** Strip leading spaces/tabs. */
function lstrip(line: string): string {
  return line.replace(/^[ \t]+/, "");
}

/** Char offset of the start of each line; offs[i] = start of line i, offs[n] = total length. */
function lineOffsets(lines: string[]): number[] {
  const offs = new Array<number>(lines.length + 1);
  offs[0] = 0;
  for (let i = 0; i < lines.length; i++) offs[i + 1] = offs[i] + lines[i].length;
  return offs;
}

/**
 * Uniform-indent tolerance. Finds the first window whose lines match `part`
 * modulo a single, uniform leading-whitespace prefix; re-indents `replace` by
 * that prefix. Aider: replace_part_with_missing_leading_whitespace. Returns null
 * if no window matches.
 */
function tryIndent(content: string, part: string, replace: string): Splice | null {
  const whole = keepLines(content);
  let partLines = keepLines(part);
  const replLines = keepLines(replace);
  const n = partLines.length;
  if (n === 0 || n > whole.length) return null;

  // Uniform outdent of part+replace by the min leading whitespace of non-blank lines.
  const leads: number[] = [];
  for (const p of partLines) if (p.trim() !== "") leads.push(leadLen(p));
  for (const r of replLines) if (r.trim() !== "") leads.push(leadLen(r));
  if (leads.length) {
    const outdent = Math.min(...leads);
    if (outdent > 0) {
      partLines = partLines.map((p) => (p.trim() !== "" ? p.slice(outdent) : p));
      for (let i = 0; i < replLines.length; i++)
        if (replLines[i].trim() !== "") replLines[i] = replLines[i].slice(outdent);
    }
  }

  const offs = lineOffsets(whole);
  for (let i = 0; i + n <= whole.length; i++) {
    const add = matchByForLeading(whole.slice(i, i + n), partLines);
    if (add === null) continue;
    const text = replLines.map((r) => (r.trim() !== "" ? add + r : r)).join("");
    return { start: offs[i], end: offs[i + n], text };
  }
  return null;
}

/**
 * Accept a window iff every line's non-whitespace content equals part's, AND
 * the leading-whitespace prefix added to each non-blank part line is the same
 * string for all of them. Aider: match_but_for_leading_whitespace. Returns that
 * uniform prefix, or null.
 */
function matchByForLeading(win: string[], part: string[]): string | null {
  const num = win.length;
  for (let i = 0; i < num; i++) {
    if (lstrip(win[i]) !== lstrip(part[i])) return null;
  }
  const adds = new Set<string>();
  for (let i = 0; i < num; i++) {
    if (win[i].trim() === "") continue;
    const diff = win[i].length - part[i].length;
    if (diff < 0) return null; // part more indented than file — not the "missing indent" case
    adds.add(win[i].slice(0, diff));
  }
  if (adds.size !== 1) return null;
  return [...adds][0];
}

/** A line that is only (optional leading ws) `...` (optional trailing ws) + newline. */
const DOTS_LINE = /^[ \t]*\.\.\.[ \t]*\r?\n$/;

/**
 * Split into alternating [text, dots, text, dots, ..., text] pieces. A run with
 * no `...` lines yields a single-element array. Mirrors Aider's re.split on
 * `(^\s*\.\.\.\n)`.
 */
function splitDots(s: string): string[] {
  const lines = keepLines(s);
  const pieces: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (DOTS_LINE.test(line)) {
      pieces.push(cur.join(""));
      pieces.push(line);
      cur = [];
    } else {
      cur.push(line);
    }
  }
  pieces.push(cur.join(""));
  return pieces;
}

/**
 * `...` elision. Splits SEARCH and REPLACE on `...` lines; counts must match
 * and the `...` pieces themselves must be equal. Each non-empty text chunk must
 * occur exactly once in `content`; an empty SEARCH chunk with a non-empty
 * REPLACE chunk inserts at end (Aider: appends to whole). Returns splices or
 * null (null = no `...`, or unpaired/mismatched/overlapping/non-unique).
 */
function ellipsisSplices(content: string, search: string, replace: string): Splice[] | null {
  const sp = splitDots(search);
  const rp = splitDots(replace);
  if (sp.length !== rp.length) return null; // unpaired ...
  if (sp.length === 1) return null; // no dots → not applicable

  for (let i = 1; i < sp.length; i += 2) {
    if (sp[i] !== rp[i]) return null; // the ... markers differ
  }

  const splices: Splice[] = [];
  for (let i = 0; i < sp.length; i += 2) {
    const part = sp[i];
    const repl = rp[i];
    if (part === "" && repl === "") continue;
    if (part === "") {
      splices.push({ start: content.length, end: content.length, text: repl });
      continue;
    }
    const first = content.indexOf(part);
    if (first < 0) return null;
    if (content.indexOf(part, first + 1) >= 0) return null; // not unique
    splices.push({ start: first, end: first + part.length, text: repl });
  }

  splices.sort((a, b) => a.start - b.start);
  for (let i = 1; i < splices.length; i++) {
    if (splices[i].start < splices[i - 1].end) return null; // overlap
  }
  return splices;
}

/**
 * Aider-style fuzzy fallback: indent tolerance (with a leading-blank-line retry,
 * Aider issue #25), then `...` elision. Returns splices against `content`, or
 * null if nothing matched. First-match only; does not disambiguate. All three
 * strings are prepped Aider-style (trailing "\n" ensured) before matching, and
 * resulting splices are clamped back to original-content space.
 */
export function fuzzySplices(content: string, search: string, replace: string): Splice[] | null {
  const prep = (s: string): string => (s === "" ? "" : s.endsWith("\n") ? s : s + "\n");
  const C = prep(content);
  const S = prep(search);
  const R = prep(replace);
  const orig = content.length;
  const clamp = (s: Splice): Splice => ({
    start: Math.min(s.start, orig),
    end: Math.min(s.end, orig),
    text: s.text,
  });

  let r = tryIndent(C, S, R);
  if (r) return [clamp(r)];
  // Drop a spurious leading blank line GPT sometimes adds, then retry indent.
  const partLines = keepLines(S);
  if (partLines.length > 2 && partLines[0].trim() === "") {
    r = tryIndent(C, partLines.slice(1).join(""), R);
    if (r) return [clamp(r)];
  }
  const es = ellipsisSplices(C, S, R);
  if (es) return es.map(clamp);
  return null;
}
