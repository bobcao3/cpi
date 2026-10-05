import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchFile, applyFileDiff, withFileEdit } from "./file-edit.ts";
import { loadEditorText } from "./text.ts";
import {
  MAX_DIFF_BLOCK_BYTES,
  MAX_DIFF_BLOCKS,
  MAX_DIFF_LINES,
} from "./udiff.ts";
import { renderEditorResult } from "./render.ts";
import { getThemeByName } from "@earendil-works/pi-coding-agent";
import { stripVTControlCharacters } from "node:util";

const cases = [
  {
    name: "numbered hunks use original coordinates despite earlier insertions",
    source: "a\r\nb\r\nc\r\nd",
    patch:
      "@@ -1 +1,2 @@\n-a\n+A\n+extra\n@@ -3 +4 @@\n-c\n+C\n@@\n-missing\n+X\n@@\n-d\n+D\n",
    output: "A\r\nextra\r\nb\r\nC\r\nd",
    hunk: 3,
    line: 8,
    applied: [1, 2],
    reason: "did not match",
  },
  {
    name: "context-only hunks count toward failure numbering but not applied changes",
    source: "before\nsection\nvalue\nafter\n",
    patch:
      "@@\n section\n@@\n-value\n+VALUE\n@@ missing scope\n+inserted\n@@\n-after\n+AFTER\n",
    output: "before\nsection\nVALUE\nafter\n",
    hunk: 3,
    line: 6,
    applied: [2],
    reason: "did not match",
  },
  {
    name: "an overlapping later hunk never applies its nonoverlapping rows",
    source: "a\nb\nc\nd\n",
    patch: "@@\n-d\n+D\n@@\n-a\n+A\n b\n c\n-d\n+other\n",
    output: "a\nb\nc\nD\n",
    hunk: 2,
    line: 4,
    applied: [1],
    reason: "Hunk 1 overlaps",
  },
  {
    name: "a later hunk with an invalid header preserves the prefix",
    source: "a\nb\nc\n",
    patch: "@@\n-a\n+A\n@@ -2broken\n-b\n+B\n@@\n-c\n+C\n",
    output: "A\nb\nc\n",
    hunk: 2,
    line: 4,
    applied: [1],
    reason: "Use @@",
  },
  {
    name: "a later hunk with missing source rows preserves the prefix",
    source: "a\nb\nc\n",
    patch: "@@\n-a\n+A\n@@ -2,1 +2,1 @@\n+B\n@@\n-c\n+C\n",
    output: "A\nb\nc\n",
    hunk: 2,
    line: 4,
    applied: [1],
    reason: "absent source lines",
  },
  {
    name: "a newline marker on a nonfinal source line stops application",
    source: "a\nb\nc\n",
    patch: "@@\n-a\n+A\n@@\n-b\n\\ No newline at end of file\n+B\n@@\n-c\n+C\n",
    output: "A\nb\nc\n",
    hunk: 2,
    line: 4,
    applied: [1],
    reason: "final line",
  },
  {
    name: "an ambiguous hunk stops before the valid suffix",
    source: "a\nsame\nsame\nc\n",
    patch: "@@\n-a\n+A\n@@\n-same\n+changed\n@@\n-c\n+C\n",
    output: "A\nsame\nsame\nc\n",
    hunk: 2,
    line: 4,
    applied: [1],
    reason: "Multiple matches",
  },
  {
    name: "failure in the first hunk leaves the valid suffix untouched",
    source: "a\nb\n",
    patch: "@@\n-missing\n+X\n@@\n-a\n+A\n",
    output: "a\nb\n",
    hunk: 1,
    line: 1,
    applied: [],
    reason: "did not match",
  },
];

for (const example of cases) {
  test(example.name, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cpi-partial-"));
    const path = join(cwd, "fixture.txt");
    try {
      await writeFile(path, example.source);
      const result = await applyPatchFile(path, {
        cwd,
        patch: example.patch,
        maxFileBytes: 262144,
      });
      assert.equal(await readFile(path, "utf8"), example.output);
      assert.deepEqual(await readdir(cwd), ["fixture.txt"]);
      const message =
        result.ok === false ? result.error : result.failure?.message;
      assert.ok(
        message?.includes(
          `Hunk ${example.hunk} failed (patch 1 line ${example.line})`,
        ),
        message,
      );
      assert.ok(message.includes(example.reason), message);
      assert.doesNotMatch(message, /{{|}}|\bblock\b/i);
      assert.ok(message.includes(`skipped hunks after ${example.hunk}`));
      if (example.applied.length) {
        assert.equal(result.ok, true);
        assert.deepEqual(result.failure?.appliedHunks, example.applied);
        assert.equal(result.applied, example.applied.length);
        assert.ok(result.diff.length > 0);
        assert.ok(
          message.includes(`Applied hunks: ${example.applied.join(", ")}`),
        );
        const theme = getThemeByName("dark")!;
        const rendered = renderEditorResult(
          "apply_patch",
          {
            details: {
              kind: "edit",
              path,
              hunks: result.applied,
              diffOps: result.diffOps,
              failure: result.failure,
              message,
            },
          },
          { isPartial: false },
          theme,
          {},
        )
          .render(100)
          .map(stripVTControlCharacters)
          .join("\n");
        assert.ok(rendered.includes("before failure"));
        assert.ok(rendered.includes(`Hunk ${example.hunk} failed`));
      } else {
        assert.equal(result.ok, false);
        assert.ok(message.includes("File unchanged"));
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("configuration opt-out preserves bytes and retry preserves required source context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-partial-config-"));
  const path = join(cwd, "fixture.txt");
  const source = "section A\nvalue\nsection B\nvalue\n";
  const prefix_result = "section A\nvalue\nsection B\nextra\nvalue\n";
  const patch = "@@ section B\n+extra\n@@\n-missing\n+VALUE\n";
  try {
    await mkdir(join(cwd, ".cpi"));
    await writeFile(path, source);
    await writeFile(
      join(cwd, ".cpi/cpi-config.json"),
      JSON.stringify({ editor: { partialApply: false } }),
    );
    const rejected = await applyPatchFile(path, {
      cwd,
      patch,
      maxFileBytes: 262144,
    });
    assert.equal(rejected.ok, false);
    assert.equal(await readFile(path, "utf8"), source);
    await writeFile(
      join(cwd, ".cpi/cpi-config.json"),
      JSON.stringify({ editor: { partialApply: true } }),
    );
    const partial = await applyPatchFile(path, {
      cwd,
      patch,
      maxFileBytes: 262144,
    });
    assert.equal(partial.ok, true);
    assert.equal(await readFile(path, "utf8"), prefix_result);
    assert.match(partial.failure!.message, /unchanged context/);
    const unscoped = await applyPatchFile(path, {
      cwd,
      patch: "@@\n-value\n+VALUE\n",
      maxFileBytes: 262144,
    });
    assert.equal(unscoped.ok, false);
    assert.equal(await readFile(path, "utf8"), prefix_result);
    const finished = await applyPatchFile(path, {
      cwd,
      patch: "@@ section B\n@@\n-value\n+VALUE\n",
      maxFileBytes: 262144,
    });
    assert.equal(finished.ok, true);
    assert.equal(finished.failure, undefined);
    assert.equal(
      await readFile(path, "utf8"),
      "section A\nvalue\nsection B\nextra\nVALUE\n",
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("later blocks cannot bypass preflight after an earlier recoverable parse failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-partial-preflight-"));
  const path = join(cwd, "fixture.txt");
  const source = "a\nb\n";
  const prefix = "@@\n-a\n+A\n@@ -2broken\n-b\n+B\n";
  const invalid = [
    "x".repeat(MAX_DIFF_BLOCK_BYTES + 1),
    "@@\n-a\n" + "+x\n".repeat(MAX_DIFF_LINES),
    "*** Delete File: fixture.txt\n@@\n-a\n+A\n",
    "@@\n-a\n+A\n".repeat(MAX_DIFF_BLOCKS),
  ];
  try {
    await writeFile(path, source);
    const opts = { cwd, path, maxFileBytes: 262144, partialApply: true };
    for (const suffix of invalid) {
      const result = await withFileEdit(path, opts, async (content) =>
        applyFileDiff(content, [prefix, suffix], loadEditorText(cwd), opts),
      );
      assert.equal(result.ok, false);
      assert.equal(await readFile(path, "utf8"), source);
    }
    const result = await withFileEdit(path, opts, async (content) =>
      applyFileDiff(
        content,
        ["@@\n-a\n+A\n", "@@\n-missing\n+B\n"],
        loadEditorText(cwd),
        opts,
      ),
    );
    assert.equal(result.ok, true);
    assert.equal(result.failure?.hunk, 2);
    assert.equal(result.failure?.block, 2);
    assert.equal(result.failure?.line, 1);
    assert.equal(await readFile(path, "utf8"), "A\nb\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("the hunk limit excludes a trailing separator and rejects oversized patches before writing", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-partial-bound-"));
  const path = join(cwd, "fixture.txt");
  try {
    for (const count of [MAX_DIFF_BLOCKS, MAX_DIFF_BLOCKS + 1]) {
      const rows = Array.from({ length: count }, (_, i) => `line-${i}`);
      const source = rows.join("\n") + "\n";
      const patch =
        rows.map((row) => `@@\n-${row}\n+${row.toUpperCase()}\n`).join("") +
        "***\n";
      await writeFile(path, source);
      const result = await applyPatchFile(path, {
        cwd,
        patch,
        maxFileBytes: 262144,
      });
      assert.equal(result.ok, count === MAX_DIFF_BLOCKS);
      assert.equal(
        await readFile(path, "utf8"),
        count === MAX_DIFF_BLOCKS ? source.toUpperCase() : source,
      );
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
