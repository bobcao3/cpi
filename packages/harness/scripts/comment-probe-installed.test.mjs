import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { init } from "es-module-lexer";
import { stageTree } from "../../cli/scripts/release-stage.mjs";

const harness = fileURLToPath(new URL("../", import.meta.url));
const skill = "skills/prose-writing-editing";

test("source and compiled comment-probe launchers parse real comments", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cpi-comment-probe-"));
  try {
    const installed = join(directory, "harness");
    await mkdir(installed);
    await init;
    await stageTree(join(harness, skill), installed, harness, skill);
    await mkdir(join(installed, "node_modules/@cpi"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../../tree-sitter-wasm", import.meta.url)),
      join(installed, "node_modules/@cpi/tree-sitter-wasm"),
      "dir",
    );
    await assert.rejects(access(join(installed, skill, "scripts/probe.mts")), {
      code: "ENOENT",
    });
    await access(join(installed, skill, "scripts/probe.mjs"));
    const target = join(directory, "sample.ts");
    const marker = "COMMENT_PROBE_MARKER_9713";
    await writeFile(target, `/** ${marker} */\nfunction workflow() {}\n`);
    for (const root of [harness, installed]) {
      const result = spawnSync(
        "sh",
        [join(root, skill, "scripts/probe"), "list", target],
        {
          env: {
            ...process.env,
            CPI_RUNTIME_KIND: "node",
            CPI_RUNTIME_BIN: process.execPath,
          },
          encoding: "utf8",
          timeout: 15000,
        },
      );
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.ok(result.stdout.includes(marker), result.stdout);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
