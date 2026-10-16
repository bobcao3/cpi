import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { COLUMN_PADDING } from "./canvas.mjs";

// beautiful-mermaid counts UTF-16 cells, so the worker restores graphemes after layout.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function terminal_columns(source: string): {
  source: string;
  replacements: [string, string][];
} {
  const used = new Set(source);
  const markers = new Map<string, string>();
  const replacements: [string, string][] = [];
  let next = 0xe000;
  let encoded = "";
  for (const { segment } of segmenter.segment(source)) {
    if (/^[\x00-\x7f]+$/.test(segment)) {
      encoded += segment;
      continue;
    }
    const width = visibleWidth(segment);
    if (!width) continue;
    if (segment.length === 1 && width === 1) {
      encoded += segment;
      continue;
    }
    let marker = markers.get(segment);
    if (!marker) {
      while (next <= 0xf8ff && used.has(String.fromCharCode(next))) next++;
      assert(next <= 0xf8ff);
      marker = String.fromCharCode(next++);
      used.add(marker);
      markers.set(segment, marker);
      replacements.push([marker, segment]);
    }
    encoded += marker + COLUMN_PADDING.repeat(width - 1);
  }
  return { source: encoded, replacements };
}
