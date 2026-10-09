import { open } from "node:fs/promises";
import {
  generateDiffString,
  type EditDiffResult,
} from "@earendil-works/pi-coding-agent";
import { resolveToCwd } from "../paths.ts";

export type { EditDiffResult };
export interface EditDiffError {
  error: string;
}
export interface Edit {
  oldText: string;
  newText: string;
}
type Replacement = {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
};

const MAX_BYTES = 8_000_000;

function normalizeLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeFuzzy(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

function replace(
  content: string,
  replacements: readonly Replacement[],
  offset = 0,
): string {
  for (let index = replacements.length - 1; index >= 0; index--) {
    const item = replacements[index];
    const position = item.matchIndex - offset;
    content =
      content.slice(0, position) +
      item.newText +
      content.slice(position + item.matchLength);
  }
  return content;
}

function preserveLines(
  original: string,
  base: string,
  replacements: readonly Replacement[],
): string {
  const originalLines = original.match(/[^\n]*\n|[^\n]+/g) ?? [];
  let offset = 0;
  const lines = (base.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
  if (originalLines.length !== lines.length)
    throw new Error(
      "Cannot preserve unchanged lines because the base content has a different line count.",
    );
  const groups: { start: number; end: number; replacements: Replacement[] }[] =
    [];
  for (const item of replacements) {
    const start = lines.findIndex(
      (line) => item.matchIndex >= line.start && item.matchIndex < line.end,
    );
    if (start < 0)
      throw new Error("Replacement range is outside the base content.");
    let end = start;
    while (
      end < lines.length &&
      lines[end].end < item.matchIndex + item.matchLength
    )
      end++;
    if (end >= lines.length)
      throw new Error("Replacement range is outside the base content.");
    end++;
    const group = groups.at(-1);
    if (group && start < group.end) {
      group.end = Math.max(group.end, end);
      group.replacements.push(item);
    } else groups.push({ start, end, replacements: [item] });
  }
  let cursor = 0;
  const result: string[] = [];
  for (const group of groups) {
    result.push(originalLines.slice(cursor, group.start).join(""));
    const start = lines[group.start].start;
    result.push(
      replace(
        base.slice(start, lines[group.end - 1].end),
        group.replacements,
        start,
      ),
    );
    cursor = group.end;
  }
  result.push(originalLines.slice(cursor).join(""));
  return result.join("");
}

function applyEdits(
  content: string,
  edits: readonly Edit[],
  path: string,
): string {
  const normalized = edits.map((edit) => ({
    oldText: normalizeLF(edit.oldText),
    newText: normalizeLF(edit.newText),
  }));
  for (let index = 0; index < normalized.length; index++) {
    if (!normalized[index].oldText.length)
      throw new Error(
        normalized.length === 1
          ? `oldText must not be empty in ${path}.`
          : `edits[${index}].oldText must not be empty in ${path}.`,
      );
  }
  const fuzzy = normalized.some(
    (edit) =>
      !content.includes(edit.oldText) &&
      normalizeFuzzy(content).includes(normalizeFuzzy(edit.oldText)),
  );
  const base = fuzzy ? normalizeFuzzy(content) : content;
  const replacements: Replacement[] = normalized
    .map((edit, editIndex) => {
      let oldText = edit.oldText;
      let matchIndex = base.indexOf(oldText);
      if (matchIndex < 0) {
        oldText = normalizeFuzzy(oldText);
        matchIndex = normalizeFuzzy(base).indexOf(oldText);
      }
      if (matchIndex < 0)
        throw new Error(
          normalized.length === 1
            ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
            : `Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
        );
      const occurrences =
        normalizeFuzzy(base).split(normalizeFuzzy(edit.oldText)).length - 1;
      if (occurrences > 1)
        throw new Error(
          normalized.length === 1
            ? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
            : `Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
        );
      return {
        editIndex,
        matchIndex,
        matchLength: oldText.length,
        newText: edit.newText,
      };
    })
    .sort((left, right) => left.matchIndex - right.matchIndex);
  for (let index = 1; index < replacements.length; index++) {
    const previous = replacements[index - 1];
    const current = replacements[index];
    if (previous.matchIndex + previous.matchLength > current.matchIndex)
      throw new Error(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
      );
  }
  const result = fuzzy
    ? preserveLines(content, base, replacements)
    : replace(base, replacements);
  if (result === content)
    throw new Error(
      normalized.length === 1
        ? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
        : `No changes made to ${path}. The replacements produced identical content.`,
    );
  return result;
}

export async function computeEditsDiff(
  path: string,
  edits: Edit[],
  cwd: string,
): Promise<EditDiffResult | EditDiffError> {
  try {
    if (
      !edits.length ||
      edits.length > 256 ||
      edits.some(
        (edit) =>
          typeof edit.oldText !== "string" || typeof edit.newText !== "string",
      ) ||
      edits.reduce(
        (size, edit) => size + edit.oldText.length + edit.newText.length,
        0,
      ) > 2_000_000
    )
      return { error: "Edit preview argument display limit exceeded." };
    const file = await open(resolveToCwd(path, cwd), "r");
    let raw: string;
    try {
      const size = (await file.stat()).size;
      if (size > MAX_BYTES)
        return { error: "Edit preview file display limit exceeded." };
      const buffer = Buffer.alloc(Math.min(MAX_BYTES + 1, size + 1));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > size)
        return { error: "Edit preview file changed during reading." };
      raw = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await file.close();
    }
    const content = normalizeLF(raw.startsWith("\uFEFF") ? raw.slice(1) : raw);
    return generateDiffString(content, applyEdits(content, edits, path));
  } catch (error) {
    const message =
      error instanceof Error && "code" in error
        ? `Could not edit file: ${path}. Error code: ${error.code}.`
        : error instanceof Error
          ? error.message
          : String(error);
    return { error: message };
  }
}
