import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { captureSessionOwner } from "../src/lib/storage/owner.ts";
import { release_temp_directory } from "../src/lib/storage/temp-dirs.ts";
import { ids, inventory, supported } from "./temp-dir-fixture.mjs";
import { temp_session } from "./temp-dir-session-fixture.mjs";
import { packagePath } from "./test-runtime.mjs";

test(
  "root close refuses another live Node host's scratch; that host can write late before joined manual release and close retry",
  supported,
  async () => {
    const fixture = await temp_session(() => ({ content: "UNUSED" }));
    const owner = captureSessionOwner(fixture.manager);
    let child, joined, directory;
    let diagnostics = "";
    try {
      const script = join(fixture.local.directory, "foreign-scratch-host.mjs");
      await writeFile(
        script,
        `
import ${JSON.stringify(pathToFileURL(packagePath("scripts/test-runtime.mjs")).href)};
import { create_temp_directory } from ${JSON.stringify(pathToFileURL(packagePath("src/lib/storage/temp-dirs.ts")).href)};
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const deadline = setTimeout(() => process.exit(93), 30000);
const directory = await create_temp_directory(JSON.parse(process.argv[2]), 'scratch', 'foreign-host');
await writeFile(join(directory.path, 'payload'), 'foreign host ready');
const finish = once(process.stdin, 'data');
process.send({ directory });
await finish;
await writeFile(join(directory.path, 'late-write'), 'foreign host wrote after close refusal');
clearTimeout(deadline);
process.stdin.destroy();
process.disconnect();
`,
      );
      child = spawn(process.execPath, [script, JSON.stringify(owner)], {
        stdio: ["pipe", "pipe", "pipe", "ipc"],
      });
      for (const stream of [child.stdout, child.stderr])
        stream.on("data", (chunk) => {
          diagnostics = (diagnostics + chunk).slice(-8192);
        });
      joined = once(child, "exit");
      joined.catch(() => {});
      const [ready] = await Promise.race([
        once(child, "message"),
        joined.then(([code, signal]) => {
          throw new Error(
            `Foreign host exited before allocation: ${code}/${signal}: ${diagnostics}`,
          );
        }),
      ]);
      directory = ready.directory;
      assert.deepEqual(directory.owner, owner);
      assert.equal(directory.type, "scratch");
      assert.equal(directory.lifecycle, "session-cleanup");
      assert.equal(
        await readFile(join(directory.path, "payload"), "utf8"),
        "foreign host ready",
      );
      assert.deepEqual(ids(await inventory(owner)), [directory.id]);
      assert.equal(child.exitCode, null);
      await assert.rejects(
        fixture.runtime.session.close({ timeoutMs: 5000 }),
        (error) => {
          assert.match(error.message, /[Pp]ending/);
          assert.match(error.message, /another host/);
          assert.ok(error.message.includes(directory.id));
          return true;
        },
      );
      assert.equal(child.exitCode, null);
      process.kill(child.pid, 0);
      assert.equal(existsSync(directory.path), true);
      assert.equal(existsSync(join(directory.path, "late-write")), false);
      assert.equal(
        await readFile(join(directory.path, "payload"), "utf8"),
        "foreign host ready",
      );
      assert.deepEqual(ids(await inventory(owner)), [directory.id]);
      child.stdin.end("finish\n");
      assert.deepEqual(await joined, [0, null], diagnostics);
      assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
      assert.equal(
        await readFile(join(directory.path, "late-write"), "utf8"),
        "foreign host wrote after close refusal",
      );
      await release_temp_directory(owner, directory.id);
      assert.equal(existsSync(directory.path), false);
      assert.deepEqual(await inventory(owner), []);
      await fixture.runtime.session.close({ timeoutMs: 5000 });
    } finally {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await joined?.catch(() => {});
        }
        if (directory && existsSync(directory.path))
          await release_temp_directory(owner, directory.id);
      } finally {
        await fixture.close();
      }
    }
  },
);
