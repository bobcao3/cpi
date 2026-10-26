import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runtimeSpawn } from "../src/lib/runtime.ts";
import { read_guardian_record } from "../src/lib/storage/journal.ts";
import { createSessionOwner } from "../src/lib/storage/owner.ts";
import {
  create_temp_directory,
  inventory_temp_directories,
  release_temp_directory,
} from "../src/lib/storage/temp-dirs.ts";

const portable = { timeout: 30000, concurrency: false };

function workspace() {
  return mkdtemp(join(tmpdir(), "cpi-storage-portable-"));
}

test(
  "temporary directory records allocate, inventory, release, and retain on every supported platform",
  portable,
  async () => {
    const directory = await workspace();
    try {
      const owner = createSessionOwner("portable-storage", directory);
      const scratch = await create_temp_directory(owner, "scratch", "portable");
      const retained = await create_temp_directory(
        owner,
        "retained",
        "portable",
      );
      const missing = await create_temp_directory(owner, "scratch", "missing");
      await writeFile(join(scratch.path, "payload"), "scratch");
      await writeFile(join(retained.path, "payload"), "retained");
      await rm(missing.path, { recursive: true, force: true });
      const inventory = await inventory_temp_directories(owner);
      assert.deepEqual(inventory.inventory_errors, []);
      assert.deepEqual(
        inventory.directories.map(({ id }) => id).sort(),
        [scratch.id, retained.id].sort(),
      );
      await release_temp_directory(owner, scratch.id);
      assert.equal(existsSync(scratch.path), false);
      assert.equal(
        await readFile(join(retained.path, "payload"), "utf8"),
        "retained",
      );
      await release_temp_directory(owner, retained.id);
      assert.deepEqual(
        (await inventory_temp_directories(owner)).directories,
        [],
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "scratch guardian removes a killed host's scope on every supported platform",
  portable,
  async () => {
    const directory = await workspace();
    const script = join(directory, "scratch-host.mjs");
    const guardian = new URL(
      "../src/lib/storage/guardian-client.ts",
      import.meta.url,
    ).href;
    const owner = new URL("../src/lib/storage/owner.ts", import.meta.url).href;
    await writeFile(
      script,
      `import { randomUUID } from "node:crypto";
import { ScratchGuardian } from ${JSON.stringify(guardian)};
import { createSessionOwner } from ${JSON.stringify(owner)};
const owner = createSessionOwner("portable-crash", process.argv[2]);
const guardian = new ScratchGuardian(owner, "scratch", randomUUID(), false);
const path = await guardian.start();
process.send({ path, record: guardian.record });
setInterval(() => {}, 1000);
`,
    );
    const runtime = runtimeSpawn();
    const child = spawn(runtime.bin, [...runtime.pre, script, directory], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: { ...process.env, NODE_OPTIONS: "", JITI_ALIAS: "" },
    });
    let diagnostics = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-8192);
      });
    let message;
    try {
      const exited = once(child, "exit");
      [message] = await Promise.race([
        once(child, "message"),
        exited.then(() => {
          throw new Error(`scratch host exited early: ${diagnostics}`);
        }),
      ]);
      assert.equal(existsSync(message.path), true);
      child.kill("SIGKILL");
      await exited;
      let record;
      for (let attempt = 0; attempt < 300; attempt++) {
        try {
          record = read_guardian_record(message.record);
          if (record.state === "closed") break;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(existsSync(message.path), false, diagnostics);
      assert.ok(record, diagnostics);
      assert.equal(record.state, "closed");
      assert.equal(record.host_closed, true);
      assert.equal(record.closure_evidence, "host_exit");
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await rm(directory, { recursive: true, force: true });
    }
  },
);
