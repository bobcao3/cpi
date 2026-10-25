import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import {
  captureSessionOwner,
  sessionArtifactPath,
} from "../src/lib/storage/owner.ts";
import { create_temp_directory } from "../src/lib/storage/temp-dirs.ts";
import { ids, inventory, supported } from "./temp-dir-fixture.mjs";
import { temp_session } from "./temp-dir-session-fixture.mjs";

const seed = (manager, content) =>
  manager.appendMessage({
    role: "user",
    content,
    timestamp: Date.now(),
  });

test(
  "automatic scratch cleanup refuses symlinks, replacement identities, and corrupt records; repair permits close and deletion",
  supported,
  async () => {
    const fixture = await temp_session(() => ({ content: "UNUSED" }));
    const { manager, runtime, host, local } = fixture;
    const owner = captureSessionOwner(manager);
    const backup = join(local.directory, "original-payload");
    let scratch, record, record_bytes;
    try {
      seed(manager, "Keep external paths safe during automatic cleanup.");
      scratch = await create_temp_directory(owner, "scratch", "identity");
      await writeFile(join(scratch.path, "owned"), "original identity");
      record = join(
        sessionArtifactPath(owner, "temp-dirs"),
        `${scratch.id}.json`,
      );
      record_bytes = await readFile(record);
      const external = join(local.directory, "external");
      await mkdir(external, { mode: 0o700 });
      const sentinel = join(external, "sentinel");
      await writeFile(sentinel, "external sentinel");
      const file = manager.getSessionFile();
      const session_bytes = await readFile(file);
      for (const fault of [
        "symlink",
        "replacement",
        "redirected-record",
        "invalid-json",
      ]) {
        if (fault === "symlink" || fault === "replacement") {
          await rename(scratch.path, backup);
          if (fault === "symlink") await symlink(external, scratch.path, "dir");
          else {
            await mkdir(scratch.path, { mode: 0o700 });
            await writeFile(
              join(scratch.path, "sentinel"),
              "replacement sentinel",
            );
          }
        } else {
          await writeFile(
            record,
            fault === "invalid-json"
              ? "{invalid"
              : JSON.stringify({ ...JSON.parse(record_bytes), path: external }),
          );
        }
        const checked = await fixture.invoke(runtime.session, "temp_dir", {
          action: "inventory",
          purpose: "inspect-fault",
        });
        assert.equal(checked.isError, true);
        assert.equal(checked.structuredContent.inventory_complete, false);
        assert.deepEqual(checked.structuredContent.directories, []);
        assert.ok(checked.structuredContent.inventory_errors.length > 0);
        await assert.rejects(
          runtime.session.close({ timeoutMs: 5000 }),
          /[Pp]ending/,
        );
        const deletion = await host.deleteSessionFile(file, {
          timeoutMs: 5000,
        });
        assert.equal(deletion.ok, false, fault);
        assert.match(deletion.error, /[Pp]ending/);
        assert.deepEqual(await readFile(file), session_bytes);
        assert.equal(await readFile(sentinel, "utf8"), "external sentinel");
        if (fault === "symlink") await unlink(scratch.path);
        else if (fault === "replacement") {
          assert.equal(
            await readFile(join(scratch.path, "sentinel"), "utf8"),
            "replacement sentinel",
          );
          await rm(scratch.path, { recursive: true });
        }
        if (existsSync(backup)) await rename(backup, scratch.path);
        await writeFile(record, record_bytes);
        assert.equal(
          await readFile(join(scratch.path, "owned"), "utf8"),
          "original identity",
        );
        assert.deepEqual(ids(await inventory(owner)), [scratch.id]);
      }
      await runtime.session.close({ timeoutMs: 5000 });
      assert.equal(existsSync(scratch.path), false);
      assert.deepEqual(await inventory(owner), []);
      assert.equal(await readFile(sentinel, "utf8"), "external sentinel");
      const deleted = await host.deleteSessionFile(file, { timeoutMs: 5000 });
      assert.equal(deleted.ok, true, deleted.error);
      assert.equal(existsSync(file), false);
    } finally {
      if (scratch && existsSync(backup)) {
        await rm(scratch.path, { recursive: true, force: true });
        await rename(backup, scratch.path);
      }
      if (record_bytes && existsSync(record))
        await writeFile(record, record_bytes);
      await fixture.close();
    }
  },
);

test(
  "reload, new, and fork preserve each owner's scratch; targeted deletion cleans only its owner and root quit cleans retired owners",
  supported,
  async () => {
    const fixture = await temp_session(() => ({ content: "UNUSED" }));
    const { manager, runtime, host } = fixture;
    try {
      seed(manager, "Original owner.");
      const original_owner = captureSessionOwner(manager);
      const original_file = manager.getSessionFile();
      const original = await create_temp_directory(
        original_owner,
        "scratch",
        "original",
      );
      const early = await fixture.invoke(runtime.session, "temp_dir", {
        action: "create",
        purpose: "early-release",
      });
      assert.equal(early.isError, false);
      for (const path of [
        fixture.local.directory,
        join(early.details.created.path, "child"),
        `${early.details.created.path}/`,
        `${early.details.created.path}/../${basename(early.details.created.path)}`,
        join(fixture.local.directory, basename(early.details.created.path)),
      ]) {
        const rejected = await fixture.invoke(runtime.session, "temp_dir", {
          action: "release",
          purpose: "reject-unowned-path",
          path,
          confirm_all_writers_stopped: true,
        });
        assert.equal(rejected.isError, true, path);
        assert.equal(existsSync(early.details.created.path), true);
        assert.equal(existsSync(fixture.local.directory), true);
      }
      const released = await fixture.invoke(runtime.session, "temp_dir", {
        action: "release",
        purpose: "early-cleanup",
        path: early.details.created.path,
        confirm_all_writers_stopped: true,
      });
      assert.equal(released.isError, false);
      assert.equal(released.details.released, early.details.created.path);
      assert.equal(existsSync(early.details.created.path), false);
      await runtime.session.reload();
      assert.deepEqual(
        captureSessionOwner(runtime.session.sessionManager),
        original_owner,
      );
      assert.deepEqual(ids(await inventory(original_owner)), [original.id]);
      assert.equal((await runtime.newSession()).cancelled, false);
      const next_manager = runtime.session.sessionManager;
      const next_owner = captureSessionOwner(next_manager);
      assert.notDeepEqual(next_owner, original_owner);
      assert.deepEqual(await inventory(next_owner), []);
      const foreign = await fixture.invoke(runtime.session, "temp_dir", {
        action: "release",
        purpose: "check-ownership",
        path: original.path,
        confirm_all_writers_stopped: true,
      });
      assert.equal(foreign.isError, true);
      assert.equal(existsSync(original.path), true);
      const entry = seed(next_manager, "Fork this owner.");
      const next = await create_temp_directory(next_owner, "scratch", "next");
      assert.equal(
        (await runtime.fork(entry, { position: "at" })).cancelled,
        false,
      );
      const fork_owner = captureSessionOwner(runtime.session.sessionManager);
      assert.notDeepEqual(fork_owner, next_owner);
      assert.deepEqual(await inventory(fork_owner), []);
      const forked = await create_temp_directory(
        fork_owner,
        "scratch",
        "forked",
      );
      for (const [owner, directory] of [
        [original_owner, original],
        [next_owner, next],
        [fork_owner, forked],
      ]) {
        assert.deepEqual(ids(await inventory(owner)), [directory.id]);
        await writeFile(join(directory.path, "scope"), owner.session_id);
      }
      const deleted = await host.deleteSessionFile(original_file, {
        timeoutMs: 5000,
      });
      assert.equal(deleted.ok, true, deleted.error);
      assert.equal(existsSync(original_file), false);
      assert.equal(existsSync(original.path), false);
      for (const [owner, directory] of [
        [next_owner, next],
        [fork_owner, forked],
      ])
        assert.equal(
          await readFile(join(directory.path, "scope"), "utf8"),
          owner.session_id,
        );
      await runtime.session.close({ timeoutMs: 5000 });
      for (const [owner, directory] of [
        [original_owner, original],
        [next_owner, next],
        [fork_owner, forked],
      ]) {
        assert.equal(existsSync(directory.path), false);
        assert.deepEqual(await inventory(owner), []);
      }
    } finally {
      await fixture.close();
    }
  },
);
