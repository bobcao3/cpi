// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatchFile } from "./file-edit.ts";
import { withPathLock } from "./lock.ts";
import {
  MAX_DIFF_BLOCK_BYTES,
  MAX_DIFF_BLOCKS,
  MAX_DIFF_LINES,
} from "./udiff.ts";

const directories: string[] = [];
const maxFileBytes = 1_048_576;

async function fixture(content: string | Buffer, name = "sample.txt") {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-file-edit-"));
  directories.push(cwd);
  const path = join(cwd, name);
  await writeFile(path, content);
  const apply = (
    patch: string,
    options: { maxFileBytes?: number; signal?: AbortSignal } = {},
  ) =>
    applyPatchFile(name, {
      cwd,
      patch,
      maxFileBytes,
      fuzzyMatch: false,
      ...options,
    });
  return { cwd, path, apply };
}

async function rejected(
  file: Awaited<ReturnType<typeof fixture>>,
  patch: string,
  options: { maxFileBytes?: number; signal?: AbortSignal } = {},
) {
  const original = await readFile(file.path);
  const entries = await readdir(file.cwd);
  const result = await file.apply(patch, options);
  expect(result.ok).toBe(false);
  if (result.ok === false) expect(result.error.length).toBeGreaterThan(0);
  expect(await readFile(file.path)).toEqual(original);
  expect(await readdir(file.cwd)).toEqual(entries);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((cwd) => rm(cwd, { recursive: true, force: true })),
  );
});

describe("applyPatchFile production filesystem integration", () => {
  test("applies multiple numbered and bare hunks against the original", async () => {
    const file = await fixture("alpha\nbeta\ngamma\ndelta\nepsilon\n");
    const result = await file.apply(
      "@@ -1,2 +1,3 @@\n alpha\n-beta\n+BETA\n+inserted\n@@\n-delta\n+DELTA\n epsilon\n",
    );
    expect(result.ok).toBe(true);
    if (result.ok === false) throw new Error(result.error);
    expect(result.applied).toBe(2);
    expect(result.match).toBe("exact");
    expect(result.diff.length).toBeGreaterThan(0);
    expect(result.diffOps.length).toBeGreaterThan(0);
    expect(result.patch).toContain("BETA");
    expect(typeof result.lsp).toBe("string");
    expect(await readFile(file.path, "utf8")).toBe(
      "alpha\nBETA\ninserted\ngamma\nDELTA\nepsilon\n",
    );
    expect(await readdir(file.cwd)).toEqual(["sample.txt"]);
  });

  for (const source of ["a\r\nb\r\n", "a\r\nb", "a\nb\n", "a\nb"]) {
    test(`preserves line endings and final newline: ${JSON.stringify(source)}`, async () => {
      const file = await fixture(source);
      expect((await file.apply("@@ -2,1 +2,1 @@\n-b\n+B\n")).ok).toBe(true);
      expect(await readFile(file.path)).toEqual(
        Buffer.from(source.replace("b", "B")),
      );
    });
  }

  for (const [source, patch, target] of [
    [
      "a\r\nb",
      "@@ -2,1 +2,1 @@\n-b\n\\ No newline at end of file\n+B",
      "a\r\nB\r\n",
    ],
    [
      "a\r\nb\r\n",
      "@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file",
      "a\r\nB",
    ],
  ]) {
    test(`honors explicit newline marker: ${JSON.stringify(source)}`, async () => {
      const file = await fixture(source);
      expect((await file.apply(patch)).ok).toBe(true);
      expect(await readFile(file.path)).toEqual(Buffer.from(target));
    });
  }

  test("rejects ambiguous unanchored matches without choosing an occurrence", async () => {
    await rejected(
      await fixture("same\nmiddle\nsame\n"),
      "@@\n-same\n+changed\n",
    );
  });

  test("a missing later hunk rolls back all earlier hunks byte-for-byte", async () => {
    await rejected(
      await fixture("a\r\nb\r\nc"),
      "@@\n-a\n+A\n@@\n-missing\n+MISSING\n",
    );
  });

  test("overlapping hunks leave the original bytes untouched", async () => {
    await rejected(
      await fixture("a\nb\nc\nd\n"),
      "@@ -2,2 +2,1 @@\n-b\n-c\n+X\n@@ -3,1 +3,1 @@\n-c\n+C\n",
    );
  });

  const hunk = "@@\n-a\n+A\n";
  for (const patch of [
    `--- a/sample.txt\n+++ b/sample.txt\n${hunk}`,
    `diff --git a/sample.txt b/sample.txt\n${hunk}`,
    `*** Begin Patch\n*** Update File: sample.txt\n${hunk}*** End Patch\n`,
    `*** Add File: created.txt\n${hunk}`,
    `*** Delete File: sample.txt\n${hunk}`,
    `*** Move to: moved.txt\n${hunk}`,
    `\`\`\`diff\n${hunk}\`\`\`\n`,
    `~~~diff\n${hunk}~~~\n`,
    `<patch>\n${hunk}</patch>\n`,
    `<diff>\n${hunk}</diff>\n`,
    `${hunk}--- a/other.txt\n+++ b/other.txt\n@@\n-b\n+B\n`,
    `${hunk}diff --git a/other.txt b/other.txt\n@@\n-b\n+B\n`,
    `${hunk}*** Update File: other.txt\n@@\n-b\n+B\n`,
    "@@ function sample\n-a\n+A\n",
    "@@ -1,1 +1,1 @@ function sample\n-a\n+A\n",
    "@@\na\n-b\n+B\n",
    "@@\n\\ No newline at end of file\n-a\n+A\n",
    "@@ -oops +1 @@\n-a\n+A\n",
    "Here is the patch:\n@@\n-a\n+A\n",
    `${hunk}Done.\n`,
  ]) {
    test(`rejects non-public syntax: ${JSON.stringify(patch)}`, async () => {
      const file = await fixture("a\nb\n");
      await writeFile(join(file.cwd, "other.txt"), "b\n");
      await rejected(file, patch);
      expect(await readFile(join(file.cwd, "other.txt"), "utf8")).toBe("b\n");
    });
  }

  test("missing files are not created", async () => {
    const file = await fixture("a\n");
    const result = await applyPatchFile("missing.txt", {
      cwd: file.cwd,
      patch: "@@ -0,0 +1,1 @@\n+a\n",
      maxFileBytes,
    });
    expect(result.ok).toBe(false);
    expect(await readdir(file.cwd)).toEqual(["sample.txt"]);
    expect(await readFile(file.path, "utf8")).toBe("a\n");
  });

  test("file size limit counts UTF-8 bytes", async () => {
    await rejected(await fixture("é\n"), "@@\n-é\n+e\n", { maxFileBytes: 2 });
  });

  test("rejects oversized patch bytes", async () => {
    await rejected(
      await fixture("a\n"),
      `@@\n-a\n+${"é".repeat(MAX_DIFF_BLOCK_BYTES / 2)}\n`,
    );
  });

  test("rejects excessive patch lines below the byte limit", async () => {
    await rejected(
      await fixture("a\n"),
      `@@\n-a\n${"+x\n".repeat(MAX_DIFF_LINES)}`,
    );
  });

  test("rejects excessive hunk count even when every hunk matches", async () => {
    const count = MAX_DIFF_BLOCKS + 1;
    const source = Array.from({ length: count }, (_, i) => `line-${i}\n`).join(
      "",
    );
    const patch = Array.from(
      { length: count },
      (_, i) => `@@\n-line-${i}\n+changed-${i}\n`,
    ).join("");
    await rejected(await fixture(source), patch);
  });

  test("aborting while queued on the shared lock prevents any mutation", async () => {
    const file = await fixture("a\n");
    const entered = gate();
    const held = gate();
    const blocker = withPathLock(file.path, async () => {
      entered.release();
      await held.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const pending = file.apply("@@\n-a\n+A\n", { signal: controller.signal });
    try {
      await nextTurn();
      controller.abort();
      expect(await readFile(file.path, "utf8")).toBe("a\n");
    } finally {
      held.release();
      await blocker;
    }
    expect((await pending).ok).toBe(false);
    expect(await readFile(file.path)).toEqual(Buffer.from("a\n"));
    expect(await readdir(file.cwd)).toEqual(["sample.txt"]);
  }, 5000);

  test("concurrent disjoint patches share withPathLock and both survive", async () => {
    const file = await fixture("first\nmiddle\nlast\n");
    const entered = gate();
    const held = gate();
    const blocker = withPathLock(file.path, async () => {
      entered.release();
      await held.promise;
    });
    await entered.promise;
    const first = file.apply("@@\n-first\n+FIRST\n");
    const last = applyPatchFile(file.path, {
      cwd: file.cwd,
      patch: "@@\n-last\n+LAST\n",
      maxFileBytes,
      fuzzyMatch: false,
    });
    try {
      await nextTurn();
      expect(await readFile(file.path, "utf8")).toBe("first\nmiddle\nlast\n");
    } finally {
      held.release();
      await blocker;
    }
    const results = await Promise.all([first, last]);
    expect(results.map((result) => result.ok)).toEqual([true, true]);
    expect(await readFile(file.path, "utf8")).toBe("FIRST\nmiddle\nLAST\n");
    expect(await readdir(file.cwd)).toEqual(["sample.txt"]);
  }, 5000);

  test.skipIf(process.platform === "win32")(
    "atomic replacement preserves executable permission bits",
    async () => {
      const file = await fixture("#!/bin/sh\necho before\n", "sample.sh");
      await chmod(file.path, 0o751);
      expect((await file.apply("@@\n-echo before\n+echo after\n")).ok).toBe(
        true,
      );
      expect((await stat(file.path)).mode & 0o777).toBe(0o751);
      expect(await readFile(file.path, "utf8")).toBe("#!/bin/sh\necho after\n");
    },
  );
});
