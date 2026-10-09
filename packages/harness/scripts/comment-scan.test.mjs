import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { countCommentLines } from "./comment-scan.mjs";
import { sourceMetrics, withSourceFiles } from "./source-metrics.mjs";

const file = join(tmpdir(), `cpi-comment-scan-${process.pid}.ts`);
test("native AST comments exclude literals and include empty bodies and end-of-file trivia", () => {
  for (const [source, expected] of [
    ['const text = "// not a comment"; // actual\n', 1],
    ["const text = `/* not a comment */\n// also literal`;\n", 0],
    ["const pattern = /\\/\\//; /* actual */\n", 1],
    ["function f() {\n /* actual */\n}\n", 1],
    ["const object = { /* actual */ };\n", 1],
    ["const text = `literal ${ /* actual */ 1 } tail`;\n", 1],
    ["const n = 1;\n// eof\n/* last */", 2],
    ["/* first\n second */\nconst n = 1; // same line\n", 3],
  ]) {
    assert.equal(
      countCommentLines(source, file).commentLines,
      expected,
      source,
    );
  }
});

test("native metrics count executable lines and statements independently of comment padding", () => {
  const source =
    "/* explanation\n continued */\n\nconst value = 1; // same line\nvoid value;\n";
  withSourceFiles(
    [file],
    (_path, parsed) => {
      assert.deepEqual(sourceMetrics(parsed), {
        totalLines: 6,
        commentLines: 3,
        sourceLines: 2,
        statements: 2,
      });
    },
    new Map([[file, source]]),
  );
});
