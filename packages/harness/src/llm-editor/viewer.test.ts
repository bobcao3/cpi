import { test } from "node:test";
import assert from "node:assert/strict";
import { parseViewerJson, renderRanges } from "./viewer.ts";

test("viewer direct JSON validates, normalizes and renders line ranges", () => {
  const result = parseViewerJson(
    JSON.stringify({
      one_line_summary: "  Describes a parser  ",
      ranges: [
        { start: 4, end: 5 },
        { start: 2, end: 3 },
        { start: 3, end: 4 },
      ],
    }),
  );
  assert.deepEqual(result, {
    summary: "Describes a parser",
    ranges: [[2, 5]],
  });
  assert.equal(
    renderRanges(["a", "b", "c", "d", "e"], result!.ranges, "..."),
    "2|b\n3|c\n4|d\n5|e",
  );
  assert.deepEqual(
    parseViewerJson('{"one_line_summary":"Nothing","ranges":[]}'),
    {
      summary: "Nothing",
      ranges: [],
    },
  );
});

test("viewer rejects malformed and unbounded direct output", () => {
  for (const text of [
    '```json\n{"one_line_summary":"ok","ranges":[]}\n```',
    '{"one_line_summary":"ok","ranges":[{"start":"1","end":2}]}',
    '{"one_line_summary":"ok","ranges":[{"start":0,"end":1}]}',
    '{"one_line_summary":"bad\\nsummary","ranges":[]}',
    JSON.stringify({
      one_line_summary: "ok",
      ranges: Array(129).fill({ start: 1, end: 1 }),
    }),
    "x".repeat(65537),
    "[]",
  ])
    assert.equal(parseViewerJson(text), null);
});
