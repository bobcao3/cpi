/**
 * Structured line-diff ops for the `llm_editor` edit-result TUI render.
 *
 * `generateDiffString` (pi-coding-agent) computes the diff + line numbers but
 * uses symmetric context and a fixed color set. For an asymmetric 3-before /
 * 2-after window + custom coloring (gray line numbers, bright code/±) we
 * re-parse its full-context output into ops and trim to the desired window.
 *
 * Pure leaf: only imports generateDiffString from pi-coding-agent.
 */

import { generateDiffString } from "@earendil-works/pi-coding-agent";

export type DiffOp =
  | { type: "context"; lineNum: string; text: string }
  | { type: "add"; lineNum: string; text: string }
  | { type: "remove"; lineNum: string; text: string }
  | { type: "skip" };

/** Huge context ⇒ generateDiffString emits every line (no skip markers). */
const FULL_CONTEXT = 1_000_000_000;

/** Mirrors pi's renderDiff parser: prefix + padded lineNum + content. */
const LINE_RE = /^([+-\s])(\s*\d*)\s(.*)$/;

function parseOps(diffStr: string): DiffOp[] {
  const ops: DiffOp[] = [];
  for (const line of diffStr.split("\n")) {
    const m = line.match(LINE_RE);
    if (!m) {
      ops.push({ type: "skip" });
      continue;
    }
    const prefix = m[1];
    const lineNum = m[2];
    const text = m[3];
    if (prefix === "+") ops.push({ type: "add", lineNum, text });
    else if (prefix === "-") ops.push({ type: "remove", lineNum, text });
    else ops.push({ type: "context", lineNum, text });
  }
  return ops;
}

/**
 * Trim ops to `before` context lines before / `after` after each change group,
 * collapsing runs with >before+after context between them into a single skip.
 * Mirrors git's hunk grouping with an asymmetric window.
 */
export function trimOps(ops: DiffOp[], before: number, after: number): DiffOp[] {
  const isChange = (o: DiffOp): boolean => o.type === "add" || o.type === "remove";
  const changes: number[] = [];
  for (let i = 0; i < ops.length; i++) if (isChange(ops[i])) changes.push(i);
  if (changes.length === 0) return [];

  const hunks: Array<{ first: number; last: number }> = [];
  let first = changes[0];
  let last = changes[0];
  for (let k = 1; k < changes.length; k++) {
    if (changes[k] - last - 1 <= before + after) last = changes[k];
    else {
      hunks.push({ first, last });
      first = changes[k];
      last = changes[k];
    }
  }
  hunks.push({ first, last });

  const out: DiffOp[] = [];
  for (let h = 0; h < hunks.length; h++) {
    const s = Math.max(0, hunks[h].first - before);
    const e = Math.min(ops.length - 1, hunks[h].last + after);
    if (h > 0) out.push({ type: "skip" });
    for (let i = s; i <= e; i++) out.push(ops[i]);
  }
  return out;
}

/** Full structured diff ops trimmed to an asymmetric before/after window. */
export function editDiffOps(
  oldText: string,
  newText: string,
  before: number,
  after: number,
): DiffOp[] {
  try {
    const { diff } = generateDiffString(oldText, newText, FULL_CONTEXT);
    return trimOps(parseOps(diff), before, after);
  } catch {
    return [];
  }
}
