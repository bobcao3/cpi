/**
 * Edit-block applier (Aider/SWE-Edit semantics). The Editor subagent returns
 * changes as an `edits` array of {oldText, newText} (pi's multi-search-replace
 * shape) via the edit-complete tool; editor.ts maps those to ReplaceBlock
 * ({search=oldText, replace=newText}) and calls applyBlocks. No markup parser —
 * the payload is structured tool-call args, not free text.
 *
 * Semantics (SWE-Edit A.2):
 *   - search must match original exactly (whitespace-sensitive; trailing newlines stripped (all of them)).
 *   - Empty search = whole-file rewrite (replace is the new full content).
 *   - Each search must be unique in the file.
 *   - Multiple blocks applied in one pass, sorted by match index, non-overlapping.
 *   - Fuzzy fallback (default on, `editor.fuzzyMatch`): when a search has zero exact hits, Aider-style uniform-indent tolerance then `...` elision are tried; still first-match, still atomic.
 *
 * Atomic: if any block fails, NOTHING is applied. Returns structured error
 * codes (no prose) so the caller (editor.ts) can render messages from text.toml.
 * Pure leaf: no pi/tui/fs/text imports; operates on strings.
 */

import { fuzzySplices, type Splice } from "./fuzzy.ts";

export interface ReplaceBlock {
  search: string;
  replace: string;
}

export type ApplyError =
  | { code: "no_blocks" }
  | { code: "empty_with_others" }
  | { code: "not_found"; block: number; fuzzy: boolean }
  | { code: "not_unique"; block: number; occurrences: number }
  | { code: "overlap"; block: number; prev: number };

export type ApplyResult =
  | { ok: true; content: string; wholeFileRewrite: boolean; applied: number; match: "exact" | "fuzzy" }
  | { ok: false; error: ApplyError };

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

/**
 * Apply parsed blocks to `content`. Whole-file rewrite short-circuits; else
 * splice-based atomic application with fuzzy fallback (default on) for SEARCH
 * blocks that have zero exact hits. Blocks are first matched exactly + uniquely;
 * on a miss, `fuzzySplices` (Aider-style uniform-indent tolerance then `...`
 * elision) is consulted unless `opts.fuzzy === false`.
 */
export function applyBlocks(
  content: string,
  blocks: ReplaceBlock[],
  opts?: { fuzzy?: boolean },
): ApplyResult {
  if (blocks.length === 0) return { ok: false, error: { code: "no_blocks" } };

  const rewrites = blocks.filter((b) => b.search === "");
  if (rewrites.length > 0) {
    if (blocks.length > 1) return { ok: false, error: { code: "empty_with_others" } };
   return { ok: true, content: rewrites[0].replace, wholeFileRewrite: true, applied: 1, match: "exact" };
  }

  let anyFuzzy = false;
  type Splice2 = Splice & { block: number };
  const splices: Splice2[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const occurrences = countOccurrences(content, b.search);
    if (occurrences === 1) {
      const start = content.indexOf(b.search);
      splices.push({ start, end: start + b.search.length, text: b.replace, block: i + 1 });
    } else if (occurrences > 1) {
      return { ok: false, error: { code: "not_unique", block: i + 1, occurrences } };
    } else {
      if (opts?.fuzzy === false) {
        return { ok: false, error: { code: "not_found", block: i + 1, fuzzy: false } };
      }
      const fz = fuzzySplices(content, b.search, b.replace);
      if (fz !== null) {
        anyFuzzy = true;
        for (const s of fz) splices.push({ ...s, block: i + 1 });
      } else {
        return { ok: false, error: { code: "not_found", block: i + 1, fuzzy: true } };
      }
    }
  }

  splices.sort((a, b) => a.start - b.start);
  for (let i = 1; i < splices.length; i++) {
    if (splices[i].start < splices[i - 1].end)
      return { ok: false, error: { code: "overlap", block: splices[i].block, prev: splices[i - 1].block } };
  }

  let out = content;
  for (let i = splices.length - 1; i >= 0; i--) {
    const s = splices[i];
    out = out.slice(0, s.start) + s.text + out.slice(s.end);
  }
  return { ok: true, content: out, wholeFileRewrite: false, applied: blocks.length, match: anyFuzzy ? "fuzzy" : "exact" };
}
