import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { init, parse } from "es-module-lexer";
import { prepareReleaseSources } from "./release-sources.mjs";
import { stage_workspace } from "./registry-stage.mjs";
import { stageInstalledFixtures } from "./verify-installed.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("release snapshots can prepare the editable fork without cloning", async () => {
  const work = await mkdtemp(join(tmpdir(), "cpi-snapshot-test-"));
  try {
    const snapshot = await prepareReleaseSources(root, work);
    const fork = resolve(process.env.CPI_FORK ?? join(root, ".pi-fork"));
    const result = spawnSync(process.execPath, ["scripts/fork.mjs"], {
      cwd: snapshot.root,
      env: { ...process.env, CPI_FORK: fork },
      encoding: "utf8",
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), fork);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("installed verification fixtures resolve the staged module and helper closure without source modules", async () => {
  const work = await mkdtemp(join(tmpdir(), "cpi-fixture-layout-test-"));
  try {
    await init;
    const installed = join(work, "harness");
    await stage_workspace(root, "packages/harness", installed);
    const scripts = await stageInstalledFixtures(installed);
    await assert.rejects(lstat(join(installed, "src")), { code: "ENOENT" });
    const queue = (await readdir(scripts)).map((name) => join(scripts, name));
    const visited = new Set();
    const missing = new Set();
    for (let index = 0; index < queue.length; index++) {
      assert.ok(
        queue.length < 2000,
        "Fixture dependency traversal exceeds its limit",
      );
      const file = queue[index];
      if (visited.has(file)) continue;
      visited.add(file);
      if ((await stat(file)).isDirectory()) {
        for (const entry of await readdir(file, { withFileTypes: true }))
          if (entry.isDirectory() || /\.(?:mjs|js|ts)$/.test(entry.name))
            queue.push(join(file, entry.name));
        continue;
      }
      const code = await readFile(file, "utf8");
      const [imports] = parse(code);
      const paths = imports
        .filter((entry) => entry.n?.startsWith("."))
        .map((entry) => [dirname(file), entry.n]);
      for (const match of code.matchAll(
        /new URL\(["']([^"']+)["'],\s*import\.meta\.url\)/g,
      ))
        paths.push([dirname(file), match[1]]);
      for (const match of code.matchAll(/packagePath\(["']([^"']+)["']/g))
        paths.push([installed, match[1]]);
      for (const match of code.matchAll(
        /join\(install,\s*["']((?:src|dist)\/[^"']+)["']/g,
      ))
        paths.push([installed, match[1]]);
      for (const [base, path] of paths) {
        const target = resolve(base, path);
        try {
          const info = await stat(target);
          if (
            (info.isDirectory() && target !== installed) ||
            /\.(?:mjs|js|ts)$/.test(target)
          )
            queue.push(target);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          missing.add(`${file.slice(work.length + 1)} -> ${path}`);
        }
      }
    }
    assert.deepEqual([...missing], []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
