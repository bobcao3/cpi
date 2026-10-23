import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  SessionManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { writeTool } from "./tool.ts";
import { withPathLock } from "./lock.ts";

function context(cwd: string) {
  const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
  return { cwd, sessionManager } as unknown as ExtensionContext;
}

test("write conflicts retain their original session across a queued session switch", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-write-test-"));
  const path = join(cwd, "existing.txt");
  const ctx = context(cwd);
  const roots: string[] = [];
  const savedDirectories: string[] = [];
  try {
    await writeFile(path, "original contents\n");
    const contents = ["", "submitted content: café 日本語\n".repeat(5000)];
    const base = await realpath(ctx.sessionManager.getSessionDir());
    let pending: ReturnType<typeof writeTool.execute>[] = [];
    await withPathLock(path, async () => {
      pending = contents.map((file_text, index) => {
        if (index) (ctx.sessionManager as SessionManager).newSession();
        roots.push(
          join(
            base,
            "artifacts",
            createHash("sha256")
              .update(ctx.sessionManager.getSessionId())
              .digest("hex"),
          ),
        );
        return writeTool.execute(
          "conflict",
          { path, file_text },
          undefined,
          undefined,
          ctx,
        );
      });
    });
    const results = await Promise.all(pending);
    for (const [index, result] of results.entries()) {
      assert.ok("isError" in result && result.isError === true);
      const details = result.details as { path: string; tempPath?: string };
      assert.ok(
        details.tempPath,
        "the failed write must report a recovery path",
      );
      savedDirectories.push(dirname(details.tempPath));
      assert.equal(details.path, path);
      assert.ok(isAbsolute(details.tempPath));
      assert.ok(!relative(roots[index], details.tempPath).startsWith(".."));
      assert.ok(
        result.content.some(
          (part) =>
            part.type === "text" && part.text.includes(details.tempPath!),
        ),
      );
      assert.equal(await readFile(details.tempPath, "utf8"), contents[index]);
      if (process.platform !== "win32") {
        assert.equal((await stat(details.tempPath)).mode & 0o777, 0o600);
        assert.equal(
          (await stat(dirname(details.tempPath))).mode & 0o777,
          0o700,
        );
      }
    }
    assert.notEqual(roots[0], roots[1]);
    assert.equal(new Set(savedDirectories).size, contents.length);
    assert.equal(await readFile(path, "utf8"), "original contents\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write creates missing parents and leaves unrelated failures as errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-write-test-"));
  const path = join(cwd, "nested", "new.txt");
  const ctx = context(cwd);
  try {
    const created = await writeTool.execute(
      "new",
      { path, file_text: "new content\n" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!("isError" in created) || created.isError !== true);
    assert.equal(await readFile(path, "utf8"), "new content\n");
    const failed = await writeTool.execute(
      "invalid-parent",
      { path: join(path, "child.txt"), file_text: "cannot be written" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok("isError" in failed && failed.isError === true);
    assert.equal((failed.details as { tempPath?: string }).tempPath, undefined);
    assert.equal(await readFile(path, "utf8"), "new content\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("write reports a conflict when owned session storage is unavailable", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "cpi-write-test-"));
  const path = join(cwd, "existing.txt");
  const ctx = context(cwd);
  try {
    await writeFile(path, "original contents\n");
    await writeFile(
      join(ctx.sessionManager.getSessionDir(), "artifacts"),
      "not a directory",
    );
    const result = await writeTool.execute(
      "unavailable-storage",
      { path, file_text: "submitted contents\n" },
      undefined,
      undefined,
      ctx,
    );
    assert.ok("isError" in result && result.isError === true);
    const details = result.details as { tempPath?: string; message: string };
    assert.equal(details.tempPath, undefined);
    assert.ok(details.message.includes(path));
    assert.match(details.message, /already exists/);
    assert.match(details.message, /not private|EEXIST|ENOTDIR/);
    assert.equal(await readFile(path, "utf8"), "original contents\n");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
