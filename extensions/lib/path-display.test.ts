import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { displayPath } from "./path-display.ts";

test("displayPath picks the shortest of absolute, home-relative and cwd-relative", () => {
  const cwd = join(homedir(), "work", "project");
  assert.equal(
    displayPath(join(cwd, "src", "deep", "file.ts"), cwd),
    "src/deep/file.ts",
  );
  assert.equal(displayPath(join(homedir(), "notes.txt"), cwd), "~/notes.txt");
  assert.equal(displayPath(homedir(), cwd), "~");
  assert.equal(displayPath("/etc/hosts", cwd), "/etc/hosts");
  assert.equal(displayPath(".", cwd), ".");
  assert.equal(displayPath("~/notes.txt", cwd), "~/notes.txt");
});
