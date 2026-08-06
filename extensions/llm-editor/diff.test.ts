// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { describe, expect, test } from "bun:test";
import { diffArrays } from "diff";
import { editDiffOps, type DiffOp } from "./diff.ts";

const linesOf = (text: string): string[] => {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/** Full untrimmed ops (huge window ⇒ single hunk, no skip markers). */
const fullOps = (oldText: string, newText: string): DiffOp[] =>
  editDiffOps(oldText, newText, 1_000_000_000, 1_000_000_000);

const join = (lines: string[]) => (lines.length ? lines.join("\n") + "\n" : "");

interface Validated {
  distance: number;
  oldLines: string[];
  newLines: string[];
}

/**
 * Walk the ops reconstructing both texts, asserting every op text and both
 * line numbers against the position it covers.
 */
function validate(ops: DiffOp[], oldText: string, newText: string): Validated {
  const oldLines = linesOf(oldText);
  const newLines = linesOf(newText);
  const rebuiltOld: string[] = [];
  const rebuiltNew: string[] = [];
  let old = 1;
  let next = 1;
  let distance = 0;
  for (const op of ops) {
    if (op.type === "skip") continue;
    if (op.type === "context") {
      expect(op.old).toBe(old);
      expect(op.new).toBe(next);
      expect(op.text).toBe(oldLines[old - 1]);
      expect(op.text).toBe(newLines[next - 1]);
      rebuiltOld.push(op.text);
      rebuiltNew.push(op.text);
      old++;
      next++;
    } else if (op.type === "remove") {
      expect(op.old).toBe(old);
      expect(op.text).toBe(oldLines[old - 1]);
      rebuiltOld.push(op.text);
      old++;
      distance++;
    } else {
      expect(op.new).toBe(next);
      expect(op.text).toBe(newLines[next - 1]);
      rebuiltNew.push(op.text);
      next++;
      distance++;
    }
  }
  expect(old).toBe(oldLines.length + 1);
  expect(next).toBe(newLines.length + 1);
  expect(join(rebuiltOld)).toBe(oldText);
  expect(join(rebuiltNew)).toBe(newText);
  return { distance, oldLines, newLines };
}

/** Minimal edit distance as computed by jsdiff (the oracle). */
function jsdiffDistance(a: string[], b: string[]): number {
  let distance = 0;
  for (const part of diffArrays(a, b))
    if (part.added || part.removed) distance += part.value.length;
  return distance;
}

/** Deterministic LCG for fuzz reproducibility. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("two-column line numbering", () => {
  test("asymmetric change renumbers trailing context on both sides", () => {
    const oldText = join(["a", "b", "c", "d", "e", "f", "g"]);
    // Remove c,d (2 lines), add x,y,z (3 lines): net +1.
    const newText = join(["a", "b", "x", "y", "z", "e", "f", "g"]);
    const ops = fullOps(oldText, newText);
    expect(ops.map((o) => o.type)).toEqual([
      "context",
      "context",
      "remove",
      "remove",
      "add",
      "add",
      "add",
      "context",
      "context",
      "context",
    ]);
    // Trailing context: old 5-7 map to new 6-8.
    expect(ops.slice(7)).toEqual([
      { type: "context", old: 5, new: 6, text: "e" },
      { type: "context", old: 6, new: 7, text: "f" },
      { type: "context", old: 7, new: 8, text: "g" },
    ]);
    // Removed lines carry only the old number, added only the new.
    expect(ops[2]).toEqual({ type: "remove", old: 3, new: null, text: "c" });
    expect(ops[4]).toEqual({ type: "add", old: null, new: 3, text: "x" });
  });

  test("net-negative change shifts the new column down", () => {
    const oldText = join(["1", "2", "3", "4", "5", "6"]);
    const newText = join(["1", "2", "X", "6"]);
    const ops = fullOps(oldText, newText);
    expect(ops[6]).toEqual({ type: "context", old: 6, new: 4, text: "6" });
  });

  test("insertion-only keeps old numbers on trailing context", () => {
    const oldText = join(["a", "b"]);
    const newText = join(["a", "n1", "n2", "b"]);
    const ops = fullOps(oldText, newText);
    expect(ops.map((o) => o.type)).toEqual([
      "context",
      "add",
      "add",
      "context",
    ]);
    expect(ops[3]).toEqual({ type: "context", old: 2, new: 4, text: "b" });
  });

  test("blank lines and empty texts", () => {
    expect(fullOps("", "a\n")).toEqual([
      { type: "add", old: null, new: 1, text: "a" },
    ]);
    expect(fullOps("a\n", "")).toEqual([
      { type: "remove", old: 1, new: null, text: "a" },
    ]);
    const ops = fullOps("a\n\nb\n", "a\nb\n");
    expect(ops).toEqual([
      { type: "context", old: 1, new: 1, text: "a" },
      { type: "remove", old: 2, new: null, text: "" },
      { type: "context", old: 3, new: 2, text: "b" },
    ]);
  });
});

describe("myers equivalence with jsdiff", () => {
  const curated: Array<[string, string]> = [
    ["a\nb\nc\n", "a\nb\nc\n"],
    ["a\nb\nc\n", "a\nc\n"],
    ["a\nb\nc\n", "a\nx\nb\nc\n"],
    ["a\nb\nc\n", "x\na\nb\nc\n"],
    ["a\nb\nc\n", "a\nb\nc\nx\n"],
    ["a\nb\nc\n", "c\nb\na\n"],
    ["a\na\na\n", "a\na\n"],
    ["x\nx\ny\nx\n", "x\ny\nx\nx\n"],
    ["\n\n\n", "\n"],
    ["\n", "\n\n"],
  ];

  for (const [i, [oldText, newText]] of curated.entries()) {
    test(`curated case ${i}`, () => {
      const ops = fullOps(oldText, newText);
      if (oldText === newText) {
        expect(ops).toEqual([]);
        return;
      }
      const { distance } = validate(ops, oldText, newText);
      expect(distance).toBe(jsdiffDistance(linesOf(oldText), linesOf(newText)));
    });
  }

  test("randomized fuzz stays valid and minimal", () => {
    const rand = lcg(0xc0ffee);
    const alphabet = ["a", "b", "c", "aa", "bb", "", "x y", "z"];
    for (let round = 0; round < 300; round++) {
      const pick = (max: number) => Math.floor(rand() * max);
      const a = Array.from(
        { length: pick(30) },
        () => alphabet[pick(alphabet.length)],
      );
      const b = Array.from(
        { length: pick(30) },
        () => alphabet[pick(alphabet.length)],
      );
      const oldText = join(a);
      const newText = join(b);
      const ops = fullOps(oldText, newText);
      const { distance } = validate(ops, oldText, newText);
      expect(distance).toBe(jsdiffDistance(a, b));
    }
  });
});

describe("distance-cap fallback", () => {
  test("degrades to a valid (non-minimal) alignment past MAX_D", () => {
    // Middle shares one line but has edit distance far above the cap.
    const shared = "anchor";
    const a = [shared, ...Array.from({ length: 200 }, (_, k) => `old-${k}`)];
    const b = [...Array.from({ length: 200 }, (_, k) => `new-${k}`), shared];
    const ops = fullOps(join(a), join(b));
    validate(ops, join(a), join(b));
  });
});

describe("trimOps window", () => {
  test("keeps before/after context and collapses distant hunks to a skip", () => {
    const oldText = join(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    const newText = join(["1", "X", "3", "4", "5", "6", "7", "Y", "9", "10"]);
    const ops = editDiffOps(oldText, newText, 1, 1);
    expect(ops.map((o) => o.type)).toEqual([
      "context",
      "remove",
      "add",
      "context",
      "skip",
      "context",
      "remove",
      "add",
      "context",
    ]);
    expect(
      ops.map((o) => (o.type === "skip" ? null : (o as { old: number }).old)),
    ).toEqual([1, 2, null, 3, null, 7, 8, null, 9]);
  });
});
