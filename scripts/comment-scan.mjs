import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const LIMIT = 0.07;

const EXCLUDED_DIRS = new Set(["node_modules", ".git", ".jj"]);

export function countCommentLines(source, file) {
  const totalLines = source.split("\n").length;
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const commentLines = new Set();
  const addRange = (range) => {
    const start = sourceFile.getLineAndCharacterOfPosition(range.pos).line;
    const end = sourceFile.getLineAndCharacterOfPosition(range.end - 1).line;
    for (let line = start; line <= end; line++) commentLines.add(line);
  };
  const stack = [sourceFile];
  while (stack.length) {
    const node = stack.pop();
    for (const range of ts.getLeadingCommentRanges(
      source,
      node.getFullStart(),
    ) ?? []) {
      addRange(range);
    }
    for (const range of ts.getTrailingCommentRanges(source, node.end) ?? []) {
      addRange(range);
    }
    for (const child of node.getChildren(sourceFile)) stack.push(child);
  }
  return { totalLines, commentLines: commentLines.size };
}

function isSource(path) {
  return path.endsWith(".ts") || path.endsWith(".mjs");
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) stack.push(path);
      else if (isSource(path)) files.push(path);
    }
  }
  return files;
}

function report(files, output) {
  const violations = [];
  for (const file of files) {
    const { totalLines, commentLines } = countCommentLines(
      readFileSync(file, "utf8"),
      file,
    );
    if (commentLines / totalLines > LIMIT) {
      const percentage = (commentLines / totalLines) * 100;
      output.write(
        `${file}: ${percentage.toFixed(1)}% comment lines > 7.0% (${commentLines}/${totalLines})\n`,
      );
      violations.push(file);
    }
  }
  return violations;
}

function main() {
  const inputPaths = process.argv.slice(2);
  const targets = inputPaths.length
    ? inputPaths.flatMap((inputPath) =>
        statSync(inputPath).isDirectory()
          ? walk(inputPath)
          : isSource(inputPath)
            ? [inputPath]
            : [],
      )
    : walk(process.cwd());
  const violations = report(targets, process.stdout);
  if (violations.length) {
    process.stdout.write(`${violations.length} violating file(s)\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
