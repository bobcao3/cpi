import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { captureSessionOwner } from "../src/lib/storage/owner.ts";
import {
  create_temp_directory,
  release_temp_directory,
  release_temp_directory_by_path,
} from "../src/lib/storage/temp-dirs.ts";
import { inventory, late_writer, supported } from "./temp-dir-fixture.mjs";
import { temp_session } from "./temp-dir-session-fixture.mjs";

test(
  "temp_dir rejects a missing purpose without allocating a directory",
  supported,
  async () => {
    let request_count = 0;
    const fixture = await temp_session(() =>
      ++request_count === 1
        ? { tools: [{ name: "temp_dir", args: { action: "create" } }] }
        : { content: "DONE" },
    );
    try {
      await fixture.runtime.session.prompt(
        "Try creating a directory without a purpose.",
      );
      const results = fixture.runtime.session.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 1);
      assert.equal(results[0].isError, true);
      assert.match(results[0].content[0].text, /purpose/);
      assert.deepEqual(
        await inventory(captureSessionOwner(fixture.manager)),
        [],
      );
    } finally {
      await fixture.close();
    }
  },
);

test(
  "real temp_dir tool finishes without a cleanup continuation, cleans scratch on close, and retains unmanaged writers across restart",
  supported,
  async () => {
    let fixture, scratch, retained, writer;
    let request_count = 0;
    const call = (args) => ({ tools: [{ name: "temp_dir", args }] });
    fixture = await temp_session(() => {
      const results = fixture.runtime.session.messages.filter(
        (message) => message.role === "toolResult",
      );
      scratch ??= results.find(
        (message) => message.details?.created?.type === "scratch",
      )?.details.created;
      retained ??= results.find(
        (message) => message.details?.created?.type === "retained",
      )?.details.created;
      switch (++request_count) {
        case 1:
          return call({ action: "create", purpose: "model-work" });
        case 2:
          return call({ action: "create", type: "retained", purpose: "keep" });
        case 3:
          return call({ action: "inventory", purpose: "inspect-work" });
        case 4:
          return call({
            action: "release",
            path: scratch.path,
            purpose: "early-cleanup",
          });
        case 5:
          return { content: "WORK_COMPLETE" };
        default:
          throw new Error("unexpected automatic cleanup continuation");
      }
    });
    const { host, manager, runtime, sessions } = fixture;
    const owner = captureSessionOwner(manager);
    try {
      await runtime.session.prompt(
        "Create scratch and retained directories, inventory them, try releasing without joining writers, then finish.",
      );
      assert.equal(runtime.session.getLastAssistantText(), "WORK_COMPLETE");
      assert.equal(request_count, 5);
      const results = runtime.session.messages.filter(
        (message) => message.role === "toolResult",
      );
      assert.equal(results.length, 4);
      for (const [index, result] of results.entries()) {
        assert.equal(result.toolName, "temp_dir");
        assert.deepEqual(result.details.owner, owner);
        assert.equal(result.details.inventory_complete, true);
        assert.deepEqual(result.details.inventory_errors, []);
        assert.equal(result.isError, index === 3);
        assert.deepEqual(
          result.details.directories.map(({ path }) => path).sort(),
          index === 0 ? [scratch.path] : [scratch.path, retained.path].sort(),
        );
        for (const data of [
          result.details,
          result.structuredContent,
          JSON.parse(result.content[0].text),
        ]) {
          if (!data) continue;
          for (const directory of [data.created, ...data.directories].filter(
            Boolean,
          ))
            assert.equal(Object.hasOwn(directory, "id"), false);
        }
      }
      assert.match(results[3].details.error, /confirm_all_writers_stopped/);
      assert.equal(scratch.lifecycle, "session-cleanup");
      assert.equal(retained.lifecycle, "explicit-release");
      assert.equal(existsSync(scratch.path), true);
      await writeFile(join(scratch.path, "work"), "alive after model finished");
      await writeFile(join(retained.path, "durable"), "retained across close");
      const file = manager.getSessionFile();
      await runtime.session.close({ timeoutMs: 5000 });
      assert.equal(existsSync(scratch.path), false);
      assert.equal(
        await readFile(join(retained.path, "durable"), "utf8"),
        "retained across close",
      );
      const restarted = host.SessionManager.open(file, sessions);
      const reopened = await fixture.runtime_for(restarted);
      assert.deepEqual(captureSessionOwner(restarted), owner);
      const current_inventory = await fixture.invoke(
        reopened.session,
        "temp_dir",
        {
          action: "inventory",
          purpose: "inspect-retained",
        },
      );
      assert.equal(current_inventory.isError, false);
      assert.equal(current_inventory.details.inventory_complete, true);
      assert.deepEqual(current_inventory.details.inventory_errors, []);
      assert.deepEqual(
        current_inventory.details.directories.map(({ path }) => path),
        [retained.path],
      );
      const unjoined = await create_temp_directory(
        owner,
        "retained",
        "unjoined",
      );
      const marker = join(unjoined.path, "late-writer");
      await writeFile(marker, "must not be auto-removed");
      writer = late_writer(marker);
      assert.deepEqual(await writer.ready, ["ready"]);
      await reopened.session.close({ timeoutMs: 5000 });
      assert.equal(await readFile(marker, "utf8"), "must not be auto-removed");
      assert.deepEqual(
        (await inventory(owner)).map(({ path }) => path).sort(),
        [retained.path, unjoined.path].sort(),
      );
      writer.worker.postMessage("finish");
      assert.equal(await writer.closed, 0);
      writer = undefined;
      assert.equal(await readFile(marker, "utf8"), "late writer joined");
      await release_temp_directory(owner, unjoined.id);
      await release_temp_directory_by_path(owner, retained.path);
      assert.equal(existsSync(retained.path), false);
      assert.deepEqual(await inventory(owner), []);
      const deleted = await host.deleteSessionFile(file, { timeoutMs: 5000 });
      assert.equal(deleted.ok, true, deleted.error);
      assert.equal(existsSync(file), false);
      assert.equal(request_count, 5);
    } finally {
      if (writer) {
        await writer.worker.terminate();
        await writer.closed.catch(() => {});
      }
      await fixture.close();
    }
  },
);
