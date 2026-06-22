// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { describe, expect, test } from "bun:test";
import { lineBodies, numberLines } from "./lines.ts";
import { parseUdiffs } from "./udiff.ts";
import { applyUdiffs } from "./udiff-apply.ts";

function apply(source: string, diffs: string[], fuzzy = true) {
  const parsed = parseUdiffs(diffs);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("parse failed");
  return applyUdiffs(source, parsed.hunks, { fuzzy });
}

function output(source: string, diffs: string[], fuzzy = true): string {
  const result = apply(source, diffs, fuzzy);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("apply failed");
  return result.content;
}

describe("numbered editor context", () => {
  test("coordinates match source lines without a trailing phantom", () => {
    expect(lineBodies("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(numberLines("a\r\nb\r\n")).toBe("1\ta\n2\tb");
    expect(numberLines("")).toBe("");
  });
});

describe("udiff parser", () => {
  test("accepts one canonical hunk per array element", () => {
    const parsed = parseUdiffs(["@@ -2,1 +2,2 @@\n b\n+c"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.hunks[0]).toMatchObject({
        oldStart: 2,
        oldCount: 1,
        newCount: 2,
      });
  });

  test("recomputes normal-hunk counts from the authoritative body", () => {
    const parsed = parseUdiffs(["@@ -1,2 +1,1 @@\n-a\n+b"]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok)
      expect(parsed.hunks[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    // A header claiming source lines the body never supplies stays fatal:
    // applying a context-free insertion there would be a guess.
    expect(parseUdiffs(["@@ -5,2 +5,3 @@\n+x"])).toMatchObject({
      ok: false,
      error: { code: "bad_count" },
    });
  });

  test("splits several hunks in one array element", () => {
    const parsed = parseUdiffs(["@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d"]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.hunks).toHaveLength(2);
      expect(parsed.hunks.map((h) => h.oldStart)).toEqual([1, 3]);
      expect(parsed.hunks.every((h) => h.block === 1)).toBe(true);
    }
  });

  test("drops wrappers and rescues prefix-less blank rows", () => {
    const parsed = parseUdiffs([
      "```diff\n--- a/f.ts\n+++ b/f.ts\n@@ -1,3 +1,3 @@\n a\n\n-b\n+B\n```",
    ]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok)
      expect(parsed.hunks[0].rows.map((r) => r.operation)).toEqual([
        "context",
        "context",
        "delete",
        "add",
      ]);
    // An unprefixed row reads as context: wrong only in that it may fail to
    // match, never in a way that deletes or inserts anything.
    const bare = parseUdiffs(["@@ -1,2 +1,2 @@\na\n-b\n+B"]);
    expect(bare).toMatchObject({ ok: true });
    if (bare.ok)
      expect(bare.hunks[0].rows[0]).toMatchObject({
        operation: "context",
        text: "a",
      });
  });

  // Both shapes are verbatim reductions of real editor-subagent completions
  // (~/.pi/agent/cpi-editor transcripts, openai-codex/gpt-5.6-luna).
  test("accepts a bare `@@` hunk separator as an unanchored hunk", () => {
    const parsed = parseUdiffs(["@@ -1 +1 @@\n-a\n+A\n@@\n-c\n+C"]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.hunks.map((h) => h.anchored)).toEqual([true, false]);
      expect(parsed.hunks[1]).toMatchObject({ oldCount: 1, newCount: 1 });
    }
    expect(parseUdiffs(["@@ @@\n-b\n+B"])).toMatchObject({ ok: true });
  });

  test("drops the codex apply_patch envelope and its bare `***` separator", () => {
    expect(
      parseUdiffs([
        "*** Begin Patch\n*** Update File: f.ts\n@@ -1 +1 @@\n-a\n+A\n*** End Patch",
      ]),
    ).toMatchObject({ ok: true });
    const split = parseUdiffs(["@@ -1 +1 @@\n-a\n+A\n***\n-c\n+C\n***"]);
    expect(split).toMatchObject({ ok: true });
    if (split.ok) expect(split.hunks).toHaveLength(2);
  });

  test("drops no-op hunks but reports an entirely no-op completion", () => {
    const parsed = parseUdiffs(["@@ -1 +1 @@\n a", "@@ -3 +3 @@\n-c\n+C"]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.hunks).toHaveLength(1);
    expect(parseUdiffs(["@@ -1 +1 @@\n a"])).toMatchObject({
      ok: false,
      error: { code: "no_changes" },
    });
  });

  test("treats a `...` row as ordinary context, not an elision", () => {
    const parsed = parseUdiffs(["@@ -1,2 +1,2 @@\n ...\n-a\n+b"]);
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.hunks[0].oldCount).toBe(2);
    expect(apply("a\nb\n", ["@@ -1,2 +1,2 @@\n ...\n-a\n+b"])).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });
});

describe("udiff application", () => {
  test("uses the declared anchor without requiring global uniqueness", () => {
    const source = "same\nother\nsame\n";
    expect(output(source, ["@@ -3,1 +3,1 @@\n-same\n+changed"])).toBe(
      "same\nother\nchanged\n",
    );
  });

  test("relocates only a unique exact match", () => {
    expect(output("a\nb\nc\n", ["@@ -1,1 +1,1 @@\n-b\n+B"])).toBe("a\nB\nc\n");
    expect(
      apply("same\nother\nsame\n", ["@@ -2,1 +2,1 @@\n-same\n+changed"]),
    ).toMatchObject({
      ok: false,
      error: { code: "ambiguous" },
    });
  });

  test("supports bounded whitespace fuzz without changing internal whitespace", () => {
    const diff = "@@ -2,2 +2,2 @@\n-a()   \n-b()\n+A()\n+B()";
    const result = apply("root\n  a()\t\n  b()\n", [diff]);
    expect(result).toMatchObject({ ok: true, match: "fuzzy" });
    if (result.ok) expect(result.content).toBe("root\n  A()\n  B()\n");
    expect(apply("root\n  a()\t\n  b()\n", [diff], false)).toMatchObject({
      ok: false,
      error: { code: "not_found", fuzzy: false },
    });
    expect(apply("root\n  a( )\n  b()\n", [diff])).toMatchObject({ ok: false });
  });

  test("locates an unanchored hunk by unique content, never by guess", () => {
    expect(output("a\nb\nc\n", ["@@\n-b\n+B"])).toBe("a\nB\nc\n");
    expect(apply("a\nb\na\n", ["@@\n-a\n+A"])).toMatchObject({
      ok: false,
      error: { code: "ambiguous" },
    });
    // A pure insertion has no content to locate and no usable coordinate.
    expect(apply("a\nb\n", ["@@\n+x"])).toMatchObject({
      ok: false,
      error: { code: "bad_anchor" },
    });
  });

  // Reduced from real transcripts: `  }` vs `  },` is a boundary the model got
  // approximately right, a closing fence vs a blank line is one it invented.
  test("fuzzes an outer context row only where the boundary is recognizable", () => {
    const object = '{\n  "bin": {\n    "a": "x"\n  },\n  "z": 1\n}\n';
    expect(
      output(object, ['@@ -2,3 +2,3 @@\n   "bin": {\n-    "a": "x"\n+    "a": "y"\n   }']),
    ).toBe('{\n  "bin": {\n    "a": "y"\n  },\n  "z": 1\n}\n');
    const fenced = "intro\n\ntext\n\ntail\n";
    expect(
      apply(fenced, ["@@ -1,3 +1,4 @@\n intro\n \n-text\n+new\n+more\n ```"]),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("never fuzzes away a change row", () => {
    // Trimming may only drop context, so a wrong `-` row stays unplaceable.
    expect(apply("a\nb\nc\n", ["@@ -1,3 +1,3 @@\n a\n-WRONG\n+B\n c"])).toMatchObject(
      { ok: false, error: { code: "not_found" } },
    );
    expect(
      apply("a\nb\nc\nd\n", ["@@ -1,4 +1,4 @@\n a\n b\n-WRONG\n+D"]),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("supports empty-file, BOF, and EOF insertions", () => {
    expect(output("", ["@@ -0,0 +1,2 @@\n+a\n+b"])).toBe("a\nb");
    expect(output("b\n", ["@@ -0,0 +1,1 @@\n+a"])).toBe("a\nb\n");
    expect(output("a", ["@@ -1,0 +2,1 @@\n+b"])).toBe("a\nb");
  });

  test("preserves CRLF and the original final-newline state", () => {
    expect(output("a\r\nb\r\n", ["@@ -2,1 +2,1 @@\n-b\n+B"])).toBe(
      "a\r\nB\r\n",
    );
    expect(output("a\nb", ["@@ -2,1 +2,1 @@\n-b\n+B"])).toBe("a\nB");
  });

  test("preserves whitespace-only added rows", () => {
    expect(output("a\n", ["@@ -1,1 +1,2 @@\n a\n+  "])).toBe("a\n  \n");
  });

  test("supports standard final-newline markers", () => {
    const marker = "\\ No newline at end of file";
    expect(output("a\n", [`@@ -1 +1 @@\n-a\n+a\n${marker}`])).toBe("a");
    expect(output("a", [`@@ -1 +1 @@\n-a\n${marker}\n+a`])).toBe("a\n");
    expect(output("x\r\na", [`@@ -2 +2 @@\n-a\n${marker}\n+a`])).toBe(
      "x\r\na\r\n",
    );
    expect(
      parseUdiffs([`@@ -1,2 +1,2 @@\n-a\n${marker}\n+b\n c`]),
    ).toMatchObject({ ok: false, error: { code: "bad_newline" } });
  });

  test("resolves all hunks against the original and rejects overlap", () => {
    const source = "a\nb\nc\nd\n";
    expect(output(source, ["@@ -4 +4 @@\n-d\n+D", "@@ -1 +1 @@\n-a\n+A"])).toBe(
      "A\nb\nc\nD\n",
    );
    expect(
      apply(source, ["@@ -2,2 +2,1 @@\n-b\n-c\n+X", "@@ -3 +3 @@\n-c\n+C"]),
    ).toMatchObject({
      ok: false,
      error: { code: "overlap" },
    });
  });

  test("allows deterministic insertion at a replacement boundary", () => {
    expect(output("a\nb\n", ["@@ -1 +0,0 @@\n-a", "@@ -1,0 +1 @@\n+x"])).toBe(
      "x\nb\n",
    );
  });

  test("bounds pathological matching work", () => {
    const source = Array(40_000).fill("a").join("\n") + "\n";
    const diff = "@@ -1,200 +1,200 @@\n" +
      Array(199).fill(" a").join("\n") + "\n-nowhere\n+A";
    expect(apply(source, [diff])).toMatchObject({
      ok: false,
      error: { code: "work_limit" },
    });
  });

  test("a failed final hunk produces no partial output", () => {
    const result = apply("a\nb\n", [
      "@@ -1 +1 @@\n-a\n+A",
      "@@ -2 +2 @@\n-missing\n+M",
    ]);
    expect(result).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect("a\nb\n").toBe("a\nb\n");
  });
});
