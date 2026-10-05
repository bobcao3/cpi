import type { Highlight } from "../lib/tree-sitter.ts";

const MAX_HL_BYTES = 8000;

interface ThemeLike {
  fg(color: string, text: string): string;
}

function colorFor(capture: string): string | null {
  if (capture === "comment" || capture === "keyword.directive")
    return "syntaxComment";
  if (capture === "keyword" || capture.startsWith("keyword."))
    return "syntaxKeyword";
  switch (capture) {
    case "function":
    case "function.call":
    case "function.builtin":
      return "syntaxFunction";
    case "variable":
    case "variable.parameter":
    case "variable.builtin":
      return "syntaxVariable";
    case "string":
    case "string.special":
    case "string.special.path":
    case "string.regexp":
      return "syntaxString";
    case "number":
      return "syntaxNumber";
    case "label":
    case "constant":
    case "constant.builtin":
      return "syntaxType";
    case "operator":
    case "character.special":
      return "syntaxOperator";
    case "punctuation.bracket":
    case "punctuation.delimiter":
    case "punctuation.special":
      return "syntaxPunctuation";
    default:
      return null;
  }
}

export function highlightRange(
  command: string,
  captures: Highlight[],
  theme: ThemeLike,
  startByte: number,
  endByte: number,
): string {
  const bytes = new TextEncoder().encode(command);
  if (endByte > bytes.length) endByte = bytes.length;
  if (startByte >= endByte) return "";
  const dec = new TextDecoder();
  if (endByte - startByte > MAX_HL_BYTES) {
    return theme.fg("text", dec.decode(bytes.subarray(startByte, endByte)));
  }
  const span = endByte - startByte;
  const colors: (string | null)[] = new Array(span).fill(null);
  for (const c of captures) {
    if (c.end <= startByte || c.start >= endByte) continue;
    const col = colorFor(c.capture);
    if (!col) continue;
    const s = Math.max(c.start, startByte) - startByte;
    const e = Math.min(c.end, endByte) - startByte;
    for (let i = s; i < e; i++) colors[i] = col;
  }
  let out = "";
  let i = 0;
  while (i < span) {
    let j = i;
    const col = colors[i];
    while (j < span && colors[j] === col) j++;
    out += theme.fg(
      col ?? "text",
      dec.decode(bytes.subarray(startByte + i, startByte + j)),
    );
    i = j;
  }
  return out;
}

export function byteLen(command: string): number {
  return new TextEncoder().encode(command).length;
}

/** Scanning byte 0x0a is safe because UTF-8 continuation bytes cannot equal it. */
export function lineBounds(command: string): {
  starts: number[];
  ends: number[];
} {
  const bytes = new TextEncoder().encode(command);
  const starts = [0];
  for (let i = 0; i < bytes.length; i++)
    if (bytes[i] === 0x0a) starts.push(i + 1);
  const ends = [...starts.slice(1), bytes.length];
  return { starts, ends };
}
