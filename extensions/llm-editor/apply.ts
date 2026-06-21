/**
 * SEARCH/REPLACE block parser + applier (Aider/SWE-Edit format).
 *
 *   <<<<<<< SEARCH
 *   <exact original>
 *   =======
 *   <replacement>
 *   >>>>>>> REPLACE
 *
 * Semantics (SWE-Edit A.2):
 *   - SEARCH must match original exactly (whitespace-sensitive).
 *   - Empty SEARCH = whole-file rewrite (REPLACE is the new full content).
 *   - Each SEARCH must be unique in the file.
 *   - Multiple blocks applied in one pass, sorted by match index, non-overlapping.
 *
 * Atomic: if any block fails, NOTHING is applied. Returns structured error
 * codes (no prose) so the caller (editor.ts) can render messages from text.toml.
 * Pure leaf: no pi/tui/fs/text imports; operates on strings + protocol markers.
 */

export interface ReplaceBlock {
  search: string;
  replace: string;
}

export type ApplyError =
  | { code: "no_blocks" }
  | { code: "empty_with_others" }
  | { code: "not_found"; block: number }
  | { code: "not_unique"; block: number; occurrences: number }
  | { code: "overlap"; block: number; prev: number };

export type ApplyResult =
  | { ok: true; content: string; wholeFileRewrite: boolean; applied: number }
  | { ok: false; error: ApplyError };

const SEARCH_START = "<<<<<<< SEARCH";
const DIVIDER = "=======";
const REPLACE_END = ">>>>>>> REPLACE";

/** Extract raw blocks from model output; lenient about surrounding prose/fences. */
export function parseBlocks(raw: string): ReplaceBlock[] {
  const first = raw.indexOf(SEARCH_START);
  const last = raw.lastIndexOf(REPLACE_END);
  if (first < 0 || last < 0 || last < first) return [];
  const body = raw.slice(first, last + REPLACE_END.length);
  const blocks: ReplaceBlock[] = [];
  for (const chunk of body.split(REPLACE_END)) {
    const s = chunk.indexOf(SEARCH_START);
    if (s < 0) continue;
    const afterStart = chunk.slice(s + SEARCH_START.length);
    const d = afterStart.indexOf(DIVIDER);
    if (d < 0) continue;
    blocks.push({
      search: stripFenceNewlines(afterStart.slice(0, d)),
      replace: stripFenceNewlines(afterStart.slice(d + DIVIDER.length)),
    });
  }
  return blocks;
}

function stripFenceNewlines(s: string): string {
  let out = s;
  if (out.startsWith("\n")) out = out.slice(1);
  if (out.endsWith("\n")) out = out.slice(0, -1);
  return out;
}

function countOccurrences(content: string, needle: string): number {
  if (needle === "") return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    i = content.indexOf(needle, i);
    if (i < 0) break;
    n++;
    i += needle.length;
  }
  return n;
}

/** Apply parsed blocks to `content`. Whole-file rewrite short-circuits; else exact + unique + non-overlapping. */
export function applyBlocks(content: string, blocks: ReplaceBlock[]): ApplyResult {
  if (blocks.length === 0) return { ok: false, error: { code: "no_blocks" } };

  const rewrites = blocks.filter((b) => b.search === "");
  if (rewrites.length > 0) {
    if (blocks.length > 1) return { ok: false, error: { code: "empty_with_others" } };
    return { ok: true, content: rewrites[0].replace, wholeFileRewrite: true, applied: 1 };
  }

  type Match = { index: number; length: number; replace: string; block: number };
  const matches: Match[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const occurrences = countOccurrences(content, b.search);
    if (occurrences === 0) return { ok: false, error: { code: "not_found", block: i + 1 } };
    if (occurrences > 1)
      return { ok: false, error: { code: "not_unique", block: i + 1, occurrences } };
    matches.push({ index: content.indexOf(b.search), length: b.search.length, replace: b.replace, block: i + 1 });
  }

  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i].index < matches[i - 1].index + matches[i - 1].length)
      return { ok: false, error: { code: "overlap", block: matches[i].block, prev: matches[i - 1].block } };
  }

  let out = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    out = out.slice(0, m.index) + m.replace + out.slice(m.index + m.length);
  }
  return { ok: true, content: out, wholeFileRewrite: false, applied: matches.length };
}
