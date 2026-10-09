#!/usr/bin/env node
// Reader-page measurement: one page is one 80x24 terminal screen; override the
// geometry with COLS and PAGE_ROWS. Long lines fold into extra rows, blank
// lines count as rows, and headings are ignored inside fenced code blocks.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const COLS = Number.parseInt(process.env.COLS ?? "80", 10);
const PAGE_ROWS = Number.parseInt(process.env.PAGE_ROWS ?? "24", 10);
const PAGES = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  roundingMode: "halfEven",
  useGrouping: false,
});

function discover() {
  try {
    return execFileSync(
      "fd",
      [
        "-e",
        "md",
        "-e",
        "mdx",
        "-t",
        "f",
        "-E",
        "node_modules",
        "-E",
        ".git",
        "-E",
        "zig-pkg",
        "-E",
        "zig-out",
        "-E",
        "dist",
        "-E",
        ".zig-cache",
        ".",
      ],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    try {
      return execFileSync("git", ["ls-files", "*.md", "*.mdx"], {
        encoding: "utf8",
      })
        .split("\n")
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      throw new Error("pass FILE arguments, or install fd / run inside git");
    }
  }
}

function width(line) {
  let col = 0;
  for (const char of line) col += char === "\t" ? 8 - (col % 8) : 1;
  return col;
}

function measure(path) {
  const text = readFileSync(path, "utf8");
  const lines =
    text === ""
      ? []
      : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n");
  let fence = false;
  let rows = 0;
  const headings = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^#{1,6} /.test(line))
      headings.push({ line: index + 1, rows, text: line });
    rows += Math.max(1, Math.ceil(width(line) / COLS));
  }
  return { lines: lines.length, rows, headings };
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length ? args : discover();
  if (!files.length) throw new Error("no markdown files found");
  for (const path of files) {
    if (!statSync(path, { throwIfNoEntry: false })?.isFile())
      throw new Error(`not a file: ${path}`);
    const { lines, rows, headings } = measure(path);
    console.log(
      `FILE\t${path}\tlines=${lines}\trows=${rows}\tpages=${PAGES.format(rows / PAGE_ROWS)}\tcols=${COLS}`,
    );
    for (const heading of headings)
      console.log(
        `HEADING\t${heading.line}\t${PAGES.format(heading.rows / PAGE_ROWS)}\t${heading.rows}\t${heading.text}`,
      );
  }
}

try {
  if (!(COLS > 0) || !(PAGE_ROWS > 0))
    throw new Error("COLS and PAGE_ROWS must be positive");
  main();
} catch (error) {
  console.error(`doc-metrics: ${error.message}`);
  process.exitCode = 1;
}
