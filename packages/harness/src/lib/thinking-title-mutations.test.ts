import assert from "node:assert/strict";
import { test } from "node:test";
import { shortest_title_mutations } from "./thinking-title-mutations.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const graphemes = (text: string) =>
  Array.from(segmenter.segment(text), ({ segment }) => segment);

function assert_single_edit(source: string, target: string): void {
  const before = graphemes(source);
  const after = graphemes(target);
  if (before.length === after.length) {
    assert.equal(
      before.filter((segment, index) => segment !== after[index]).length,
      1,
      `${JSON.stringify(source)} -> ${JSON.stringify(target)}`,
    );
    return;
  }
  assert.equal(Math.abs(before.length - after.length), 1);
  const longer = before.length > after.length ? before : after;
  const shorter = before.length > after.length ? after : before;
  assert.ok(
    longer.some((_, index) =>
      [...longer.slice(0, index), ...longer.slice(index + 1)].every(
        (segment, position) => segment === shorter[position],
      ),
    ),
    `${JSON.stringify(source)} -> ${JSON.stringify(target)}`,
  );
}

function assert_path(
  source: string,
  target: string,
  distance: number,
): readonly string[] {
  const frames = shortest_title_mutations(source, target);
  assert.equal(frames.length, distance);
  if (distance > 0) assert.equal(frames.at(-1), target);
  let previous = source;
  for (const frame of frames) {
    assert_single_edit(previous, frame);
    previous = frame;
  }
  return frames;
}

test("paths have independently known minimum edit counts and single-edit frames", () => {
  for (const [source, target, distance] of [
    ["kitten", "sitting", 3],
    ["sitting", "kitten", 3],
    ["flaw", "lawn", 2],
    ["saturday", "sunday", 3],
    ["intention", "execution", 5],
    ["abc", "xyz", 3],
    ["abc", "axbc", 1],
    ["axbc", "abc", 1],
  ] as const)
    assert_path(source, target, distance);
});

test("equal-cost paths prefer substitution, then deletion, then insertion", () => {
  assert.deepEqual(assert_path("ab", "ba", 2), ["bb", "ba"]);
  assert.deepEqual(assert_path("aba", "bab", 2), ["ba", "bab"]);
  assert.deepEqual(assert_path("kitten", "sitting", 3), [
    "sitten",
    "sittin",
    "sitting",
  ]);
});

test("edits progress left-to-right without disturbing shared prefixes or suffixes", () => {
  assert.deepEqual(assert_path("prefix cat suffix", "prefix dog suffix", 3), [
    "prefix dat suffix",
    "prefix dot suffix",
    "prefix dog suffix",
  ]);
  assert.deepEqual(assert_path("foo tail", "foo new tail", 4), [
    "foo ntail",
    "foo netail",
    "foo newtail",
    "foo new tail",
  ]);
  assert.deepEqual(assert_path("foo new tail", "foo tail", 4), [
    "foo ew tail",
    "foo w tail",
    "foo  tail",
    "foo tail",
  ]);
  assert.deepEqual(assert_path("aab", "ab", 1), ["ab"]);
});

test("emoji, combining marks, flags, and joiner sequences remain whole graphemes", () => {
  for (const [source, target, distance] of [
    ["A👩🏽‍💻e\u0301Z", "A👨‍👩‍👧‍👦o\u0308Z", 2],
    ["x🇺🇸y", "x🇯🇵y", 1],
    ["a👩🏽‍💻b", "ab", 1],
    ["ab", "a👩🏽‍💻b", 1],
    ["e\u0301", "é", 1],
  ] as const)
    assert_path(source, target, distance);
  assert.deepEqual(shortest_title_mutations("A👩🏽‍💻e\u0301Z", "A👨‍👩‍👧‍👦o\u0308Z"), [
    "A👨‍👩‍👧‍👦e\u0301Z",
    "A👨‍👩‍👧‍👦o\u0308Z",
  ]);
});

test("identical and empty titles do not introduce redundant frames", () => {
  assert.deepEqual(assert_path("", "", 0), []);
  assert.deepEqual(assert_path("unchanged 👩🏽‍💻", "unchanged 👩🏽‍💻", 0), []);
  assert.deepEqual(assert_path("", "abc", 3), ["a", "ab", "abc"]);
  assert.deepEqual(assert_path("abc", "", 3), ["bc", "c", ""]);
});

test("the 160-grapheme boundary animates and longer titles snap without truncation", () => {
  assert_path("x".repeat(160), "y".repeat(160), 160);
  assert_path("👩🏽‍💻".repeat(160), "👨‍👩‍👧‍👦".repeat(160), 160);
  const long_title = "👩🏽‍💻".repeat(161);
  for (const [source, target] of [
    [long_title, "short"],
    ["short", long_title],
    ["", long_title],
    [long_title, ""],
    [long_title, `${long_title} end`],
  ] as const)
    assert.deepEqual(shortest_title_mutations(source, target), [target]);
  assert.deepEqual(shortest_title_mutations(long_title, long_title), []);
});

test("oversized clusters bound segmentation work and preserve the complete target", () => {
  const huge_cluster = `a${"\u0301".repeat(100_000)}`;
  assert.deepEqual(shortest_title_mutations(`${huge_cluster}bc`, "xyz"), [
    "xyz",
  ]);
  assert.deepEqual(shortest_title_mutations("xyz", `${huge_cluster}bc`), [
    `${huge_cluster}bc`,
  ]);
  assert.deepEqual(shortest_title_mutations(huge_cluster, huge_cluster), []);
});
