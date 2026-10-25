import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir, readlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureSessionOwner } from "../src/lib/storage/owner.ts";
import { release_temp_directory_by_path } from "../src/lib/storage/temp-dirs.ts";
import { disposeAll } from "../src/lib/lsp/manager.ts";
import { getSessionTarget, readTarget } from "../src/shell/ghostmux.ts";
import { until } from "./shell-persistence.integration.helper.mjs";
import { nodeProgram } from "./shell-platform.mjs";
import { inventory, supported } from "./temp-dir-fixture.mjs";
import { temp_session } from "./temp-dir-session-fixture.mjs";

const execute = promisify(execFile);
const dead = (pid) =>
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

async function launch_writer(fixture, name, source, producer = "sh") {
  const ready = join(fixture.local.directory, `${name}.ready`);
  const command = await nodeProgram(
    fixture.local.directory,
    name,
    `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
${source}
writeFileSync(${JSON.stringify(ready)}, String(process.pid));
`,
  );
  const result = await fixture.invoke(fixture.runtime.session, producer, {
    description: name,
    command: `exec ${command}`,
    ...(producer === "sh" ? { waitfor: 0.05 } : { interval: 60 }),
  });
  assert.equal(result.isError, false);
  assert.equal(
    result.details.status,
    producer === "sh" ? "running" : "repeating",
  );
  await until(() => existsSync(ready), `${name} never became ready`);
  const writer_pid = Number(await readFile(ready, "utf8"));
  assert.ok(Number.isInteger(writer_pid) && writer_pid > 0);
  const target = await getSessionTarget(String(writer_pid));
  assert.equal(writer_pid, target.pid);
  process.kill(writer_pid, 0);
  assert.equal((await readTarget(target.statePath)).completed, false);
  return { target, writer_pid, result };
}

async function log_handles(path) {
  const descriptors = await readdir("/proc/self/fd");
  const matches = await Promise.all(
    descriptors.map(async (descriptor) => {
      try {
        return (await readlink(`/proc/self/fd/${descriptor}`)) === path
          ? descriptor
          : undefined;
      } catch (error) {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    }),
  );
  return matches.filter((descriptor) => descriptor !== undefined);
}

async function shutdown_daemon(target) {
  if (!target) return;
  await execute(target.binaryPath, ["-S", target.socketPath, "kill-server"], {
    timeout: 5000,
  }).catch(() => {});
}

for (const producer of ["sh", "sh_repeat_until"])
  test(
    `native ${producer} orderly quit joins its writer and closes producer logs before removing scratch`,
    supported,
    async () => {
      const fixture = await temp_session(() => ({ content: "UNUSED" }), {
        native: true,
      });
      let job;
      try {
        const created = await fixture.invoke(
          fixture.runtime.session,
          "temp_dir",
          {
            action: "create",
            purpose: "managed-writer",
          },
        );
        assert.equal(created.isError, false);
        const scratch = created.details.created;
        const payload = join(scratch.path, "writes");
        job = await launch_writer(
          fixture,
          `${producer}-scratch-writer`,
          `
appendFileSync(${JSON.stringify(payload)}, 'started\\n');
setInterval(() => appendFileSync(${JSON.stringify(payload)}, 'writing\\n'), 25);
setTimeout(() => process.exit(91), 30000);
`,
          producer,
        );
        assert.match(await readFile(payload, "utf8"), /started/);
        let producer_log;
        if (producer === "sh") {
          const refusal = await fixture.invoke(
            fixture.runtime.session,
            "sh_detach",
            {
              id: job.result.details.id,
            },
          );
          assert.equal(refusal.isError, true);
          assert.match(
            refusal.content.map((part) => part.text ?? "").join("\n"),
            /scratch/i,
          );
        } else {
          const record = fixture.manager
            .getEntries()
            .filter(
              (entry) =>
                entry.type === "custom" &&
                entry.customType === "cpi-repeat" &&
                entry.data.id === job.result.details.id,
            )
            .at(-1);
          assert.ok(record, "Repeat launch must persist its producer log");
          producer_log = record.data.log_path;
          assert.ok((await log_handles(producer_log)).length > 0);
        }
        assert.equal(existsSync(scratch.path), true);
        assert.equal((await readTarget(job.target.statePath)).completed, false);
        process.kill(job.writer_pid, 0);
        await fixture.runtime.session.close({ timeoutMs: 5000 });
        const native = JSON.parse(
          await readFile(job.target.statusPath, "utf8"),
        );
        assert.equal(native.session.uid, job.target.uid);
        assert.equal(native.session.pid, job.target.pid);
        assert.equal(native.server_pid, job.target.serverPid);
        if (producer === "sh") assert.equal(native.session.exit_code, 137);
        else
          assert.ok(
            [137, 143].includes(native.session.exit_code),
            `Repeat writer must die from SIGKILL or SIGTERM, got ${native.session.exit_code}`,
          );
        assert.equal((await readTarget(job.target.statePath)).completed, true);
        dead(job.target.pid);
        dead(job.writer_pid);
        assert.equal(existsSync(scratch.path), false);
        if (producer_log) {
          assert.ok((await readFile(producer_log)).length > 0);
          assert.deepEqual(await log_handles(producer_log), []);
        }
        assert.deepEqual(
          await inventory(captureSessionOwner(fixture.manager)),
          [],
        );
      } finally {
        try {
          await shutdown_daemon(job?.target);
        } finally {
          await disposeAll();
          await fixture.close();
        }
      }
    },
  );

test(
  "retained-only native detached writer survives close, writes afterwards, and is explicitly released only after native completion",
  supported,
  async () => {
    const fixture = await temp_session(() => ({ content: "UNUSED" }), {
      native: true,
    });
    let job;
    try {
      const created = await fixture.invoke(
        fixture.runtime.session,
        "temp_dir",
        {
          action: "create",
          type: "retained",
          purpose: "detached-writer",
        },
      );
      assert.equal(created.isError, false);
      const retained = created.details.created;
      const payload = join(retained.path, "after-close");
      const gate = join(fixture.local.directory, "writer-go");
      job = await launch_writer(
        fixture,
        "retained-writer",
        `
const deadline = setTimeout(() => process.exit(92), 30000);
const poll = setInterval(() => {
  if (!existsSync(${JSON.stringify(gate)})) return;
  writeFileSync(${JSON.stringify(payload)}, 'written after close');
  clearInterval(poll);
  clearTimeout(deadline);
}, 25);
`,
      );
      const detached = await fixture.invoke(
        fixture.runtime.session,
        "sh_detach",
        {
          id: job.result.details.id,
        },
      );
      assert.notEqual(detached.isError, true);
      assert.equal(detached.details.detached, true);
      const owner = captureSessionOwner(fixture.manager);
      await fixture.runtime.session.close({ timeoutMs: 5000 });
      assert.equal(existsSync(retained.path), true);
      assert.equal(existsSync(payload), false);
      assert.deepEqual(
        (await inventory(owner)).map(({ path }) => path),
        [retained.path],
      );
      assert.equal((await readTarget(job.target.statePath)).completed, false);
      process.kill(job.target.pid, 0);
      process.kill(job.writer_pid, 0);
      await writeFile(gate, "finish");
      await until(
        async () => (await readTarget(job.target.statePath)).completed,
        "Detached writer did not complete after close",
      );
      const native = JSON.parse(await readFile(job.target.statusPath, "utf8"));
      assert.equal(native.session.exit_code, 0);
      dead(job.target.pid);
      dead(job.writer_pid);
      assert.equal(await readFile(payload, "utf8"), "written after close");
      await release_temp_directory_by_path(owner, retained.path);
      assert.equal(existsSync(retained.path), false);
      assert.deepEqual(await inventory(owner), []);
    } finally {
      try {
        await shutdown_daemon(job?.target);
      } finally {
        await disposeAll();
        await fixture.close();
      }
    }
  },
);
