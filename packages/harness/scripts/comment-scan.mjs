import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sourceMetrics, withSourceFiles } from "./source-metrics.mjs";

const LIMIT = 0.07;

const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  ".jj",
  ".zig-cache",
  "zig-pkg",
  "zig-out",
]);

export function countCommentLines(source, file) {
  let result;
  withSourceFiles(
    [file],
    (_file, parsed) => {
      const { totalLines, commentLines } = sourceMetrics(parsed);
      result = { totalLines, commentLines };
    },
    new Map([[resolve(file), source]]),
  );
  return result;
}

function isSource(path) {
  return /\.[cm]?[jt]s$/.test(path);
}

function walk(root) {
  const files = [];
  const stack = [root];
  let directories = 0;
  while (stack.length) {
    if (++directories > 10000) throw new Error("Directory scan limit exceeded");
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.isFile() && isSource(path)) files.push(path);
    }
  }
  return files;
}

function report(files, output) {
  const violations = [];
  withSourceFiles(files, (file, source) => {
    const { totalLines, commentLines } = sourceMetrics(source);
    if (commentLines / totalLines > LIMIT) {
      const percentage = (commentLines / totalLines) * 100;
      output.write(
        `${file}: ${percentage.toFixed(1)}% comment lines > 7.0% (${commentLines}/${totalLines})\n`,
      );
      violations.push(file);
    }
  });
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
