import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ScratchGuardian } from "../src/lib/storage/guardian-client.ts";
import { createSessionOwner } from "../src/lib/storage/owner.ts";
import { read_guardian_record } from "../src/lib/storage/journal.ts";

test(
  "a late pending receipt after a native timeout does not poison cleanup retry",
  {
    skip: process.platform !== "linux" || process.getuid?.() === 0,
    timeout: 20000,
  },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cpi-guardian-transport-"));
    const owner = createSessionOwner("guardian-transport-job", workspace);
    const scope = new ScratchGuardian(owner, "scratch", randomUUID(), false);
    let stopped = false;
    let timer;
    try {
      await scope.start();
      await chmod(dirname(scope.path), 0o500);
      assert.equal(scope.child.kill("SIGSTOP"), true);
      stopped = true;
      await assert.rejects(scope.close(), /timed out/);
      const late = once(scope.child.stdout, "data");
      assert.equal(scope.child.kill("SIGCONT"), true);
      stopped = false;
      const [bytes] = await Promise.race([
        late,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("late receipt missing")),
            5000,
          );
        }),
      ]);
      clearTimeout(timer);
      assert.equal(JSON.parse(bytes.toString("utf8")).state, "pending");
      await chmod(dirname(scope.path), 0o700);
      await scope.close();
      assert.equal((await read_guardian_record(scope.record)).state, "closed");
    } finally {
      clearTimeout(timer);
      if (stopped) scope.child.kill("SIGCONT");
      await chmod(dirname(scope.path), 0o700);
      if (
        scope.child &&
        scope.child.exitCode === null &&
        scope.child.signalCode === null
      ) {
        const closed = once(scope.child, "close");
        scope.child.stdin.write('{"command":"close"}\n');
        await closed;
      }
      await rm(workspace, { recursive: true, force: true });
    }
  },
);
