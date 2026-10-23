import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionOwner } from "../src/lib/storage/owner.ts";
import {
  list_temp_directories,
  release_temp_directory,
} from "../src/lib/storage/temp-dirs.ts";
import {
  allocate_workers,
  ids,
  inventory,
  release_all,
  supported,
} from "./temp-dir-fixture.mjs";

test(
  "concurrent Node workers enforce the shared 64-directory limit and reuse every released slot",
  supported,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cpi-temp-dir-workers-"));
    const owner = createSessionOwner(
      "original-session",
      join(root, "sessions"),
    );
    try {
      const first = await allocate_workers(owner, [20, 20, 20, 20]);
      const created = first
        .filter((result) => result.directory)
        .map((result) => result.directory);
      const failures = first.filter((result) => result.error);
      assert.equal(created.length, 64);
      assert.equal(new Set(ids(created)).size, 64);
      assert.equal(failures.length, 16);
      for (const failure of failures)
        assert.match(failure.error, /allocation limit/);
      for (const directory of created) {
        assert.deepEqual(directory.owner, owner);
        assert.equal(directory.lifecycle, "session-cleanup");
        await writeFile(join(directory.path, "payload"), directory.id);
      }
      assert.deepEqual(ids(await inventory(owner)), ids(created));
      const released = created.filter((_, index) => index % 4 === 0);
      const batches = [0, 1, 2, 3].map((index) =>
        released.slice(index * 4, index * 4 + 4).map(({ id }) => id),
      );
      const second = await allocate_workers(owner, [8, 8, 8, 8], batches);
      const replacements = second
        .filter((result) => result.directory)
        .map((result) => result.directory);
      assert.equal(replacements.length, released.length);
      assert.equal(second.filter((result) => result.error).length, 16);
      for (const result of second.filter((result) => result.error))
        assert.match(result.error, /allocation limit/);
      const survivors = created.filter(
        (directory) => !released.includes(directory),
      );
      assert.deepEqual(
        ids(await inventory(owner)),
        ids([...survivors, ...replacements]),
      );
      for (const directory of survivors)
        assert.equal(
          await readFile(join(directory.path, "payload"), "utf8"),
          directory.id,
        );
      for (const directory of released)
        assert.equal(existsSync(directory.path), false);
    } finally {
      await release_all(owner);
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "full owners isolate inventory and release refuses symlinks and identity replacements until repaired",
  supported,
  async () => {
    const root = await mkdtemp(join(tmpdir(), "cpi-temp-dir-identity-"));
    const owner = createSessionOwner("same-id", join(root, "original"));
    const other_directory = createSessionOwner("same-id", join(root, "other"));
    const other_session = createSessionOwner("other-id", owner.session_dir);
    let directory;
    const backup = join(root, "original-payload");
    try {
      const [result] = await allocate_workers(owner, [1]);
      assert.ok(result.directory, result.error);
      directory = result.directory;
      await writeFile(join(directory.path, "owned"), "original identity");
      for (const stranger of [other_directory, other_session]) {
        assert.deepEqual(await inventory(stranger), []);
        await assert.rejects(release_temp_directory(stranger, directory.id), {
          code: "ENOENT",
        });
      }
      const external = join(root, "external");
      await mkdir(external, { mode: 0o700 });
      await writeFile(join(external, "sentinel"), "external sentinel");
      await rename(directory.path, backup);
      await symlink(external, directory.path, "dir");
      let unsafe = await list_temp_directories(owner);
      assert.deepEqual(unsafe.alive, []);
      assert.ok(unsafe.issues.length > 0);
      await assert.rejects(
        release_temp_directory(owner, directory.id),
        /unsafe|identity/,
      );
      assert.equal(
        await readFile(join(external, "sentinel"), "utf8"),
        "external sentinel",
      );
      await unlink(directory.path);
      await mkdir(directory.path, { mode: 0o700 });
      await writeFile(
        join(directory.path, "replacement"),
        "replacement sentinel",
      );
      unsafe = await list_temp_directories(owner);
      assert.deepEqual(unsafe.alive, []);
      assert.ok(unsafe.issues.some((issue) => /identity/.test(issue)));
      await assert.rejects(
        release_temp_directory(owner, directory.id),
        /identity/,
      );
      assert.equal(
        await readFile(join(directory.path, "replacement"), "utf8"),
        "replacement sentinel",
      );
      assert.equal(
        await readFile(join(backup, "owned"), "utf8"),
        "original identity",
      );
      await rm(directory.path, { recursive: true });
      await rename(backup, directory.path);
      assert.deepEqual(ids(await inventory(owner)), [directory.id]);
      await release_temp_directory(owner, directory.id);
      assert.equal(existsSync(directory.path), false);
      assert.deepEqual(await inventory(owner), []);
      assert.equal(
        await readFile(join(external, "sentinel"), "utf8"),
        "external sentinel",
      );
    } finally {
      if (directory && existsSync(backup)) {
        await rm(directory.path, { recursive: true, force: true });
        await rename(backup, directory.path);
      }
      await release_all(owner);
      await rm(root, { recursive: true, force: true });
    }
  },
);
