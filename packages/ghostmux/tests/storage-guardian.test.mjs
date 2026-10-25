import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binary =
  process.env.GHOSTMUX_BIN ??
  fileURLToPath(new URL("../zig-out/bin/ghostmux", import.meta.url));
const linux = { skip: process.platform !== "linux", timeout: 15000 };
const exists = (path) =>
  access(path).then(
    () => true,
    () => false,
  );
const record = (path) => readFile(path, "utf8").then(JSON.parse);

async function fixture(t) {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "guardian-native-")),
  );
  const root = join(directory, "scratch");
  const journal = join(directory, "journal");
  await Promise.all([
    mkdir(root, { mode: 0o700 }),
    mkdir(journal, { mode: 0o700 }),
  ]);
  const children = [];
  t.after(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await once(child, "close");
      }
    }
    await rm(directory, { recursive: true, force: true });
  });
  const start = async (overrides = {}) => {
    const child = spawn(binary, ["--storage-guardian"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = once(child, "close").then(([code, signal]) => ({
      code,
      signal,
      stderr,
    }));
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    const next = async () => {
      let timer;
      try {
        const result = await Promise.race([
          lines.next(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`guardian response timeout: ${stderr}`)),
              5000,
            );
          }),
        ]);
        assert.equal(result.done, false, stderr);
        return JSON.parse(result.value);
      } finally {
        clearTimeout(timer);
      }
    };
    const request = {
      version: 1,
      host_pid: process.pid,
      session_id: "native-test",
      session_dir: directory,
      root,
      journal,
      id: randomUUID(),
      retain: false,
      ...overrides,
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);
    return {
      child,
      next,
      exited,
      request,
      command: (command) =>
        child.stdin.write(`${JSON.stringify({ command })}\n`),
    };
  };
  return { directory, root, journal, start };
}

test(
  "guardian durably registers, removes only its scope without following symlinks, and retains opted-in data",
  linux,
  async (t) => {
    const f = await fixture(t);
    const g = await f.start();
    const ready = await g.next();
    assert.equal(ready.state, "ready");
    assert.equal(ready.version, 1);
    assert.equal(ready.path, join(f.root, `scratch-${g.request.id}`));
    const intent = await record(ready.record);
    assert.equal(intent.host_pid, process.pid);
    assert.equal(intent.closure_evidence, "none");
    assert.ok(intent.identity.inode > 0);
    const outside = join(f.directory, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "untouched");
    await mkdir(join(ready.path, "nested"));
    await writeFile(join(ready.path, "nested", "data"), "remove");
    await symlink(outside, join(ready.path, "outside-link"));
    g.command("close");
    assert.equal((await g.next()).state, "closed");
    assert.equal((await g.exited).code, 0);
    assert.equal(await exists(ready.path), false);
    assert.equal(await readFile(join(outside, "keep"), "utf8"), "untouched");
    assert.equal(
      (await record(ready.record)).closure_evidence,
      "controller_close",
    );
    assert.equal((await record(ready.record)).state, "closed");

    const retained = await f.start({ retain: true });
    const r = await retained.next();
    await writeFile(join(r.path, "keep"), "retained");
    retained.command("close");
    assert.equal((await retained.next()).state, "retained");
    assert.equal((await retained.exited).code, 0);
    assert.equal(await readFile(join(r.path, "keep"), "utf8"), "retained");
    assert.equal((await record(r.record)).state, "retained");
  },
);

test(
  "replacement identity stays pending, query is non-destructive, and another close can retry",
  linux,
  async (t) => {
    const f = await fixture(t);
    const g = await f.start();
    const ready = await g.next();
    const moved = join(f.root, "original");
    await rename(ready.path, moved);
    g.command("close");
    const missing = await g.next();
    assert.equal(missing.state, "pending");
    assert.equal(missing.error, "ScopeMissing");
    assert.equal(await exists(moved), true);
    await mkdir(ready.path, { mode: 0o700 });
    await writeFile(join(ready.path, "keep"), "replacement");
    g.command("close");
    const pending = await g.next();
    assert.equal(pending.state, "pending");
    assert.equal(pending.error, "IdentityMismatch");
    assert.equal((await record(ready.record)).state, "pending");
    assert.equal(
      await readFile(join(ready.path, "keep"), "utf8"),
      "replacement",
    );
    g.command("query");
    assert.equal((await g.next()).state, "pending");
    await rm(ready.path, { recursive: true });
    await rename(moved, ready.path);
    g.command("close");
    assert.equal((await g.next()).state, "closed");
    assert.equal((await g.exited).code, 0);
    assert.equal(await exists(ready.path), false);
  },
);

test(
  "restart leaves uncertain records pending without durable pidfd closure evidence",
  linux,
  async (t) => {
    const f = await fixture(t);
    const uncertain = await f.start();
    const a = await uncertain.next();
    uncertain.child.stdin.end();
    uncertain.child.kill("SIGKILL");
    await uncertain.exited;
    const pending = await f.start();
    const b = await pending.next();
    const moved = join(f.root, "original");
    await rename(b.path, moved);
    await mkdir(b.path, { mode: 0o700 });
    pending.command("close");
    assert.equal((await pending.next()).state, "pending");
    pending.child.kill("SIGKILL");
    await pending.exited;
    await rm(b.path, { recursive: true });
    await rename(moved, b.path);
    const fresh = await f.start();
    await fresh.next();
    assert.equal(await exists(a.path), true);
    assert.equal((await record(a.record)).closure_evidence, "none");
    assert.equal(await exists(b.path), true);
    assert.equal((await record(b.record)).state, "pending");
    assert.equal((await record(b.record)).closure_evidence, "controller_close");
    fresh.command("close");
    assert.equal((await fresh.next()).state, "closed");
    assert.equal((await fresh.exited).code, 0);
  },
);

test(
  "guardian refuses wrong parent and non-private roots before granting",
  linux,
  async (t) => {
    const f = await fixture(t);
    const wrong = await f.start({ host_pid: process.pid + 1 });
    const rejection = await wrong.exited;
    assert.equal(rejection.code, 1);
    assert.match(rejection.stderr, /InvalidRegistration/);
    await chmod(f.root, 0o755);
    const unsafe = await f.start();
    const refused = await unsafe.exited;
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /UnsafeSocketDirectory/);
  },
);
