import "@cpi/cli/bootstrap";
import "./loopback-network.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  rmdir,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { createCostSocket, sendCostReport } from "../src/cost-tree/socket.ts";
import { renderDiagnostics } from "../src/lib/lsp/diagnostics-overflow.ts";
import { installReleaseBinary } from "../src/lib/lsp/release.ts";
import {
  captureSessionOwner,
  sessionArtifactPath,
} from "../src/lib/storage/owner.ts";
import {
  storage_directory,
  with_temporary_directory,
} from "../src/lib/storage/paths.ts";

const exec = promisify(execFile);
const unix = {
  skip: process.platform === "win32",
  timeout: 15000,
  concurrency: false,
};

async function isolated(work) {
  const directory = await mkdtemp(join(tmpdir(), "cpi-paths-test-"));
  const previous = process.env.CPI_STORAGE_ROOT;
  process.env.CPI_STORAGE_ROOT = join(directory, "storage");
  try {
    await work(directory, process.env.CPI_STORAGE_ROOT);
  } finally {
    if (previous === undefined) delete process.env.CPI_STORAGE_ROOT;
    else process.env.CPI_STORAGE_ROOT = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function inside(root, path) {
  const suffix = relative(root, path);
  assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`), path);
}

async function privatePath(path, mode) {
  const info = await stat(path);
  assert.equal(info.mode & 0o777, mode);
  assert.equal(info.uid, process.getuid());
}

test(
  "relocated storage keeps durable data while scoped scratch is removed",
  unix,
  async () => {
    await isolated(async (_directory, root) => {
      const retained = [];
      for (const area of ["runtime", "state", "cache"]) {
        const directory = storage_directory(area, "integration");
        inside(join(root, area), directory);
        await privatePath(directory, 0o700);
        const file = join(directory, "retained");
        await writeFile(file, area);
        retained.push([file, area]);
      }
      let scratch;
      await with_temporary_directory("integration", async (directory) => {
        scratch = directory;
        inside(join(root, "scratch"), directory);
        await privatePath(directory, 0o700);
        await writeFile(join(directory, "temporary"), "scratch");
      });
      assert.equal(existsSync(scratch), false);
      const expected = new Error("callback failed");
      await assert.rejects(
        with_temporary_directory("integration", async (directory) => {
          scratch = directory;
          await writeFile(join(directory, "partial"), "partial");
          throw expected;
        }),
        (error) => error === expected,
      );
      assert.equal(existsSync(scratch), false);
      for (const [file, contents] of retained)
        assert.equal(await readFile(file, "utf8"), contents);
    });
  },
);

test(
  "real release installation cleans downloads on success, verification, extraction and interrupted HTTP",
  unix,
  async () => {
    await isolated(async (directory, root) => {
      const fixture = join(directory, "fixture");
      await mkdir(fixture);
      const payload = "#!/bin/sh\nprintf 'installed fixture\\n'\n";
      await writeFile(join(fixture, "tool"), payload);
      const archive = join(directory, "fixture.tar.gz");
      await exec("tar", ["-czf", archive, "-C", fixture, "tool"]);
      const bytes = await readFile(archive);
      const server = createServer((request, response) => {
        if (request.url === "/broken.tar.gz")
          return response.end("not a tar archive");
        if (request.url === "/interrupted.tar.gz") {
          response.writeHead(200, { "content-length": bytes.length + 100 });
          response.write(bytes.subarray(0, 10));
          setImmediate(() => response.destroy());
          return;
        }
        response.end(bytes);
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const url = `http://127.0.0.1:${server.address().port}`;
      const dest = join(directory, "installed", "tool");
      const install = (asset, verify) =>
        installReleaseBinary({
          url: `${url}/${asset}.tar.gz`,
          archiveExt: "tar.gz",
          binPaths: ["tool"],
          dest,
          env: { ...process.env },
          verify,
        });
      try {
        assert.equal(
          await install("fixture", async (path) => {
            inside(join(root, "scratch"), path);
            assert.deepEqual(await readFile(path), bytes);
          }),
          dest,
        );
        assert.equal(await readFile(dest, "utf8"), payload);
        assert.equal((await stat(dest)).mode & 0o777, 0o755);
        assert.deepEqual(await readdir(join(root, "scratch", "release")), []);
        for (const [asset, verify, pattern] of [
          [
            "fixture",
            async () => {
              throw new Error("fixture signature rejected");
            },
            /fixture signature rejected/,
          ],
          ["broken", undefined, /tar|gzip|archive/i],
          [
            "interrupted",
            undefined,
            /fetch|terminated|socket|aborted|other side/i,
          ],
        ]) {
          await assert.rejects(install(asset, verify), pattern);
          assert.deepEqual(await readdir(join(root, "scratch", "release")), []);
          assert.equal(await readFile(dest, "utf8"), payload);
        }
      } finally {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    });
  },
);

test(
  "cost transport honors relocation and securely falls back for an overlong Unix socket path",
  unix,
  async () => {
    await isolated(async (_directory, root) => {
      const report = {
        version: 1,
        accounts: [
          { id: "run:fixture", input: 19, output: 3, cost: 0.25, count: 1 },
        ],
      };
      for (const long of [false, true]) {
        process.env.CPI_STORAGE_ROOT = long
          ? join(root, "long-root-".repeat(15))
          : root;
        const received = [];
        const socket = createCostSocket((value) => received.push(value));
        try {
          await socket.ready;
          if (long) {
            assert.ok(
              !socket.path.startsWith(process.env.CPI_STORAGE_ROOT + sep),
            );
            assert.ok(Buffer.byteLength(socket.path) <= 100);
          } else inside(join(root, "runtime"), socket.path);
          await privatePath(dirname(socket.path), 0o700);
          await privatePath(dirname(dirname(socket.path)), 0o700);
          await privatePath(socket.path, 0o600);
          assert.equal(await sendCostReport(socket.path, report), true);
          assert.deepEqual(received, [report]);
        } finally {
          await Promise.all([socket.close(), socket.close()]);
        }
        assert.equal(existsSync(socket.path), false);
        assert.equal(existsSync(dirname(socket.path)), false);
        assert.equal(await sendCostReport(socket.path, report), false);
        if (long) await rmdir(dirname(dirname(socket.path)));
      }
    });
  },
);

test(
  "retained diagnostics keep the captured session owner after identity changes and scratch cleanup",
  unix,
  async () => {
    await isolated(async (directory) => {
      const sessionDirectory = join(directory, "sessions");
      await mkdir(sessionDirectory, { mode: 0o700 });
      const host = await hostCodingAgent();
      const identity = host.SessionManager.create(directory, sessionDirectory);
      const owner = captureSessionOwner(identity);
      identity.newSession();
      const replacement = captureSessionOwner(identity);
      assert.notEqual(owner.session_id, replacement.session_id);
      const diagnostics = [
        "first diagnostic",
        "retained second diagnostic",
      ].map((message) => ({
        severity: "error",
        message,
        source: "fixture",
        file: "/fixture.ts",
        startLine: 1,
        startCol: 1,
        endLine: 1,
        endCol: 2,
      }));
      let scratch;
      let rendered;
      await with_temporary_directory("diagnostics", async (directory) => {
        scratch = directory;
        rendered = await renderDiagnostics(diagnostics, { cap: 1, owner });
      });
      assert.equal(existsSync(scratch), false);
      assert.ok(rendered.fullPath);
      inside(sessionArtifactPath(owner, "lsp-diagnostics"), rendered.fullPath);
      assert.equal(
        existsSync(sessionArtifactPath(replacement, "lsp-diagnostics")),
        false,
      );
      await privatePath(dirname(rendered.fullPath), 0o700);
      await privatePath(rendered.fullPath, 0o600);
      const full = await readFile(rendered.fullPath, "utf8");
      for (const diagnostic of diagnostics)
        assert.ok(full.includes(diagnostic.message));
    });
  },
);

test(
  "configured roots fail closed without following symlinks or changing caller permissions",
  unix,
  async () => {
    await isolated(async (directory) => {
      const unsafe = join(directory, "unsafe");
      await mkdir(unsafe);
      await chmod(unsafe, 0o755);
      assert.throws(
        () =>
          storage_directory("scratch", "negative", {
            env: { CPI_STORAGE_ROOT: unsafe },
          }),
        /not private/,
      );
      assert.equal((await stat(unsafe)).mode & 0o777, 0o755);
      assert.deepEqual(await readdir(unsafe), []);
      const target = join(directory, "symlink-target");
      const link = join(directory, "symlink-root");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, link, "dir");
      assert.throws(
        () =>
          storage_directory("scratch", "negative", {
            env: { CPI_STORAGE_ROOT: link },
          }),
        /not a real directory/,
      );
      assert.deepEqual(await readdir(target), []);
      assert.throws(
        () => storage_directory("scratch", "../escape"),
        /invalid storage purpose/,
      );
    });
  },
);

test(
  "fresh CLI bootstrap relocates Pi outputs and env snapshots retain explicit ownership",
  unix,
  async () => {
    await isolated(async (directory, root) => {
      const bootstrap = new URL("../../cli/bootstrap.mjs", import.meta.url)
        .href;
      const output = new URL(
        "../../../.pi-fork/packages/coding-agent/src/utils/output-files.ts",
        import.meta.url,
      ).href;
      const temporary = new URL(
        "../../../.pi-fork/packages/coding-agent/src/utils/temp-paths.ts",
        import.meta.url,
      ).href;
      const script = join(directory, "bootstrap-probe.mjs");
      await writeFile(
        script,
        `
import ${JSON.stringify(bootstrap)};
import { writeOutputFile } from ${JSON.stringify(output)};
import { createTempDirectory } from ${JSON.stringify(temporary)};
const file = await writeOutputFile("bootstrap", ".txt", "retained CLI output");
const scratch = createTempDirectory("bootstrap-");
console.log(JSON.stringify({ file, scratch }));
`,
      );
      const env = {
        ...process.env,
        CPI_STORAGE_ROOT: root,
        CPI_TEMP_DIR: join(directory, "stale-scratch"),
        CPI_OUTPUT_DIR: join(directory, "stale-output"),
      };
      const { stdout } = await exec(process.execPath, [script], { env });
      const result = JSON.parse(stdout);
      inside(join(root, "state"), result.file);
      inside(join(root, "scratch"), result.scratch);
      assert.equal(await readFile(result.file, "utf8"), "retained CLI output");
      await privatePath(result.file, 0o600);
      assert.equal(existsSync(env.CPI_TEMP_DIR), false);
      assert.equal(existsSync(env.CPI_OUTPUT_DIR), false);
      const capture = fileURLToPath(
        new URL("../bin/env-capture", import.meta.url),
      );
      const owner = {
        session_id: "original-full-session-owner",
        session_dir: join(directory, "sessions"),
      };
      const capture_env = {
        ...env,
        CPI_ARTIFACT_SESSION_ID: owner.session_id,
        CPI_ARTIFACT_SESSION_DIR: owner.session_dir,
        TEST_SNAPSHOT_SECRET: "private-fixture-secret",
      };
      const captured = await exec("bash", [capture, "owned"], {
        env: capture_env,
      });
      const retained = join(
        sessionArtifactPath(owner, "env-captures"),
        "owned.env",
      );
      assert.ok(
        (await readFile(retained, "utf8"))
          .split("\n")
          .includes("TEST_SNAPSHOT_SECRET=private-fixture-secret"),
      );
      assert.ok(!captured.stdout.includes(capture_env.TEST_SNAPSHOT_SECRET));
      await privatePath(retained, 0o600);
      const files = await readdir(dirname(retained));
      assert.deepEqual(files, ["owned.env"]);
      delete capture_env.CPI_ARTIFACT_SESSION_ID;
      delete capture_env.CPI_ARTIFACT_SESSION_DIR;
      await exec("bash", [capture, "ownerless"], { env: capture_env });
      const ownerless = join(
        storage_directory("state", "env-captures"),
        "ownerless.env",
      );
      assert.ok(
        (await readFile(ownerless, "utf8")).includes(
          "TEST_SNAPSHOT_SECRET=private-fixture-secret",
        ),
      );
      assert.equal(await readFile(result.file, "utf8"), "retained CLI output");
      const obstructed = join(dirname(ownerless), "obstructed.env");
      await mkdir(obstructed);
      await assert.rejects(
        exec("bash", [capture, "obstructed"], { env: capture_env }),
      );
      assert.deepEqual(await readdir(obstructed), []);
      assert.deepEqual((await readdir(dirname(ownerless))).sort(), [
        "obstructed.env",
        "ownerless.env",
      ]);
    });
  },
);
