import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import {
  Marked,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { getCwd } from "../lib/cwd.ts";
import { mermaid_message } from "./text.ts";
import { render_mermaid } from "./engine.ts";

export const MERMAID_WIDTH = 100;
const MAX_FILE_BYTES = 1024 * 1024;
export const MERMAID_DIAGRAM_LIMIT = 8;
const parser = new Marked();

export function mermaid_file(path: string): boolean {
  return [".mmd", ".mermaid"].includes(extname(path).toLowerCase());
}

export function mermaid_document(path: string): boolean {
  return (
    mermaid_file(path) ||
    [".md", ".markdown"].includes(extname(path).toLowerCase())
  );
}

export function read_diagram_file(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error(mermaid_message("file_limit"));
    const content = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < content.length) {
      const count = readSync(fd, content, bytes, content.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error(mermaid_message("file_limit"));
    return content.subarray(0, bytes).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export interface Diagram {
  raw: string;
  start?: number;
  source?: string;
  closed?: boolean;
  file?: string;
  line: number;
  error?: string;
}

function local_diagram(href: string, base: string): string | undefined {
  let decoded = href;
  try {
    decoded = decodeURIComponent(href);
  } catch {}
  if (!/\.(mmd|mermaid)$/i.test(decoded)) return undefined;
  if (
    (!isAbsolute(decoded) && /^[a-z][a-z\d+.-]*:/i.test(decoded)) ||
    decoded.startsWith("//")
  )
    throw new Error(mermaid_message("local_only"));
  return resolve(base, decoded);
}

export function diagrams(markdown: string, base = getCwd()): Diagram[] {
  markdown = markdown.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(markdown) > MAX_FILE_BYTES)
    throw new Error(mermaid_message("file_limit"));
  const found: Diagram[] = [];
  let offset = 0;
  let line = 1;
  for (const token of parser.lexer(markdown)) {
    if (
      token.type === "code" &&
      /^(mmd|mermaid)$/i.test(token.lang?.trim() ?? "")
    ) {
      const opening = token.raw.match(/^ {0,3}(`{3,}|~{3,})/);
      const ending = token.raw.trimEnd().match(/(?:^|\n) {0,3}(`+|~+)[ \t]*$/);
      const closed = !!(
        opening &&
        ending &&
        ending[1][0] === opening[1][0] &&
        ending[1].length >= opening[1].length
      );
      found.push({
        raw: token.raw,
        start: offset,
        source: token.text,
        closed,
        line,
      });
    } else if (token.type === "paragraph" || token.type === "heading") {
      let cursor = 0;
      for (const child of token.tokens ?? []) {
        const at = token.raw.indexOf(child.raw, cursor);
        if (at < 0) continue;
        cursor = at + child.raw.length;
        if (child.type !== "image") continue;
        try {
          const file = local_diagram(child.href, base);
          if (file)
            found.push({
              raw: child.raw,
              start: offset + at,
              file,
              line: line + token.raw.slice(0, at).split("\n").length - 1,
            });
        } catch (error) {
          found.push({
            raw: child.raw,
            start: offset + at,
            line,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (found.length > MERMAID_DIAGRAM_LIMIT) break;
      }
    }
    offset += token.raw.length;
    line += token.raw.split("\n").length - 1;
    if (found.length > MERMAID_DIAGRAM_LIMIT) break;
  }
  return found;
}

export function diagram_result(diagram: Diagram, width: number) {
  try {
    if (diagram.error) return { error: diagram.error, warnings: [] };
    return render_mermaid(
      diagram.source ?? read_diagram_file(diagram.file!),
      width,
    );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
    };
  }
}

function literal_markdown(text: string): string {
  const rows = text.split("\n").map((line) => {
    const content = line.trim() ? line : "\u00a0";
    const longest = Math.max(
      0,
      ...Array.from(content.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(longest + 1);
    return `${fence} ${content} ${fence}`;
  });
  return `\n\n${rows.join("  \n")}\n\n`;
}

function safe_source(source: string): string {
  return source.replace(
    /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

function preparing_diagram(width: number): string {
  const message = mermaid_message("preparing");
  if (width < 5) return literal_markdown(truncateToWidth(message, width));
  const columns = Math.min(visibleWidth(message), width - 4);
  const top = `┌─${"─".repeat(columns)}─┐`;
  const bottom = `└─${"─".repeat(columns)}─┘`;
  const rows = wrapTextWithAnsi(message, columns).map(
    (row) => `│ ${row}${" ".repeat(columns - visibleWidth(row))} │`,
  );
  return literal_markdown([top, ...rows, bottom].join("\n"));
}

export function transform_mermaid(
  markdown: string,
  width: number,
  base = getCwd(),
  is_streaming = false,
): string {
  markdown = markdown.replace(/\r\n?/g, "\n");
  const replacements = diagrams(markdown, base);
  let offset = 0;
  let output = "";
  const deadline = Date.now() + 1000;
  for (const [index, diagram] of replacements.entries()) {
    const at = diagram.start ?? -1;
    if (at < 0) continue;
    output += markdown.slice(offset, at);
    offset = at + diagram.raw.length;
    if (diagram.closed === false) {
      output += is_streaming
        ? preparing_diagram(width)
        : safe_source(diagram.raw);
      continue;
    }
    const result =
      index >= MERMAID_DIAGRAM_LIMIT || Date.now() > deadline
        ? { error: mermaid_message("diagram_limit"), warnings: [] }
        : diagram_result(diagram, width);
    const warnings = [
      ...result.warnings,
      ...(result.error ? [result.error] : []),
    ];
    const fits = result.text
      ?.split("\n")
      .every((line) => visibleWidth(line) <= width);
    output +=
      result.text && fits
        ? literal_markdown(result.text)
        : safe_source(diagram.raw);
    if (warnings.length)
      output += literal_markdown(
        mermaid_message("warning", {
          message: safe_source(warnings.join("; ")),
        }),
      );
  }
  return output + markdown.slice(offset);
}

export function file_diagrams(path: string): Diagram[] {
  const source = read_diagram_file(path);
  return mermaid_file(path)
    ? [{ raw: source, source, line: 1 }]
    : diagrams(source, dirname(path));
}
