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

  test("rejects malformed counts, prefixes, and multiple hunks", () => {
    expect(parseUdiffs(["@@ -1,2 +1,1 @@\n-a\n+b"])).toMatchObject({
      ok: false,
      error: { code: "bad_count" },
    });
    expect(parseUdiffs(["@@ -1 +1 @@\na"])).toMatchObject({
      ok: false,
      error: { code: "bad_prefix" },
    });
    expect(
      parseUdiffs(["@@ -1 +1 @@\n-a\n+b\n@@ -2 +2 @@\n-c\n+d"]),
    ).toMatchObject({
      ok: false,
      error: { code: "multiple_hunks" },
    });
  });

  test("reserves a context-only ellipsis between explicit regions", () => {
    expect(parseUdiffs(["@@ -1,3 +1,3 @@\n ...\n-a\n+b"])).toMatchObject({
      ok: false,
      error: { code: "bad_elision" },
    });
    expect(parseUdiffs(["@@ -1,9 +1,9 @@\n a\n ...\n-z\n+Z"])).toMatchObject({
      ok: true,
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

  test("preserves an elided source span byte-for-byte", () => {
    const source = "start\r\nold\r\nmiddle  \r\nend\r\n";
    const diff = "@@ -1,4 +1,4 @@\n start\n-old\n+new\n ...\n-end\n+END";
    expect(output(source, [diff])).toBe("start\r\nnew\r\nmiddle  \r\nEND\r\n");
  });

  test("bounds elisions by header span and rejects ambiguous allocations", () => {
    const diff =
      "@@ -1,7 +1,7 @@\n-start\n+START\n ...\n mid\n ...\n-end\n+END";
    expect(apply("start\nx\nmid\ny\nmid\nz\nend\n", [diff])).toMatchObject({
      ok: false,
      error: { code: "ambiguous" },
    });
    expect(
      apply("start\nold\nmiddle\nend\n", [
        "@@ -1,5 +1,5 @@\n start\n-old\n+new\n ...\n-end\n+END",
      ]),
    ).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
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

  test("bounds pathological elision matching work", () => {
    const source = Array(12_000).fill("a").join("\n") + "\n";
    const diff =
      "@@ -1,10000 +1,10000 @@\n-a\n+A\n ...\n missing\n ...\n-a\n+A";
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
