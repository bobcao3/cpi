/**
 * Structured line-diff ops for the `llm_editor` edit-result TUI render,
 * computed from the two texts directly (no display-string parsing, no
 * imports): a bounded Myers line diff, then a walk giving every line its old-
 * and new-file number so the renderer draws two columns. Past the distance
 * cap it degrades to a correct non-minimal delete+insert alignment.
 */

export type DiffOp =
  | { type: "context"; old: number; new: number; text: string }
  | { type: "remove"; old: number; new: null; text: string }
  | { type: "add"; old: null; new: number; text: string }
  | { type: "skip" };

type RawOp = { type: "context" | "remove" | "add"; text: string };

const MAX_D = 600;

function linesOf(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function trivialOps(a: string[], b: string[]): RawOp[] {
  const ops: RawOp[] = a.map((text) => ({ type: "remove", text }));
  for (const text of b) ops.push({ type: "add", text });
  return ops;
}

/** Forward Myers search with a bounded trace, backtracked into raw ops; null when the cap is hit. */
function myersOps(a: string[], b: string[]): RawOp[] | null {
  const n = a.length;
  const m = b.length;
  const cap = Math.min(n + m, MAX_D);
  const offset = cap;
  const v = new Int32Array(2 * cap + 1).fill(-1);
  v[offset + 1] = 0;
  const trace: Int32Array[] = [];
  let distance = -1;
  outer: for (let d = 0; d <= cap; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])
          ? v[offset + k + 1]
          : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        distance = d;
        break outer;
      }
    }
    trace.push(v.slice());
  }
  if (distance < 0) return null;
  const reversed: RawOp[] = [];
  let x = n;
  let y = m;
  for (let d = distance; d >= 1; d--) {
    const prev = trace[d - 1];
    const k = x - y;
    const prevK =
      k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])
        ? k + 1
        : k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: "context", text: a[x - 1] });
      x--;
      y--;
    }
    // Undo the move: k-1 came via delete, k+1 via insert.
    if (prevK === k - 1) {
      reversed.push({ type: "remove", text: a[x - 1] });
      x--;
    } else {
      reversed.push({ type: "add", text: b[y - 1] });
      y--;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ type: "context", text: a[x - 1] });
    x--;
    y--;
  }
  return reversed.reverse();
}

function computeOps(oldText: string, newText: string): DiffOp[] {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let aEnd = a.length;
  let bEnd = b.length;
  while (aEnd > start && bEnd > start && a[aEnd - 1] === b[bEnd - 1]) {
    aEnd--;
    bEnd--;
  }
  const raw: RawOp[] = [];
  for (let i = 0; i < start; i++) raw.push({ type: "context", text: a[i] });
  const aMid = a.slice(start, aEnd);
  const bMid = b.slice(start, bEnd);
  const common = new Set(bMid);
  const shares = aMid.some((line) => common.has(line));
  raw.push(
    ...(shares
      ? (myersOps(aMid, bMid) ?? trivialOps(aMid, bMid))
      : trivialOps(aMid, bMid)),
  );
  for (let i = aEnd; i < a.length; i++)
    raw.push({ type: "context", text: a[i] });

  const ops: DiffOp[] = [];
  let old = 1;
  let next = 1;
  for (const op of raw) {
    if (op.type === "context") {
      ops.push({ type: "context", old, new: next, text: op.text });
      old++;
      next++;
    } else if (op.type === "remove") {
      ops.push({ type: "remove", old, new: null, text: op.text });
      old++;
    } else {
      ops.push({ type: "add", old: null, new: next, text: op.text });
      next++;
    }
  }
  return ops;
}

/** Trim to `before` context before / `after` after each change group; distant groups collapse to a skip. */
export function trimOps(
  ops: DiffOp[],
  before: number,
  after: number,
): DiffOp[] {
  const isChange = (o: DiffOp): boolean =>
    o.type === "add" || o.type === "remove";
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

export function editDiffOps(
  oldText: string,
  newText: string,
  before: number,
  after: number,
): DiffOp[] {
  return trimOps(computeOps(oldText, newText), before, after);
}
