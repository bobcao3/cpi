import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { reserveTranscript } from "../src/lib/subagent-artifacts.ts";
import { SubagentObservation } from "../src/lib/subagent-observation.ts";
import { ensureSubagentRpc, stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { state } from "../src/lib/subagent-rpc-runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "cpi-subagent-resources-"));
const artifacts = join(directory, "subagent-transcripts");
mkdirSync(artifacts);
const active = join(artifacts, "0000000000000-active");
const release = reserveTranscript(active, artifacts);
const runtimeKeys = [
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_RUNTIME_DIR",
  "PI_SESSION_DIR",
  "HOME",
];
const runtimeEnv = new Map(runtimeKeys.map((key) => [key, process.env[key]]));
let observation;
try {
  for (const suffix of [".md", ".stderr"])
    writeFileSync(active + suffix, "ACTIVE");
  for (let index = 1; index <= 2048; index++) {
    const base = join(
      artifacts,
      `${String(index).padStart(13, "0")}-completed`,
    );
    for (const suffix of [".md", ".stderr"])
      writeFileSync(base + suffix, "ARCHIVED");
  }
  observation = new SubagentObservation({
    runId: "resource-check",
    env: { PI_SESSION_DIR: directory },
  });
  assert.equal(readdirSync(artifacts).length, 4096);
  assert(
    existsSync(active + ".md") && existsSync(active + ".stderr"),
    "active transcript removed",
  );
  assert(!existsSync(join(artifacts, "0000000000001-completed.md")));
  assert(!existsSync(join(artifacts, "0000000000001-completed.stderr")));
  assert(existsSync(observation.result.markdownPath));
  console.log(
    "PASS retention rotates complete artifact pairs without rejecting new runs or deleting active transcripts",
  );

  if (process.platform !== "win32") {
    const longRoot = join(directory, "rpc-runtime-" + "long-".repeat(24));
    mkdirSync(longRoot);
    for (const key of runtimeKeys) process.env[key] = longRoot;
  }
  const endpoint = await ensureSubagentRpc();
  if (process.platform !== "win32") {
    assert(Buffer.byteLength(endpoint, "utf8") <= 100);
    const socketStat = lstatSync(endpoint);
    assert.equal(socketStat.uid, process.getuid());
    assert.equal(socketStat.mode & 0o777, 0o600);
  }
  const listener = state().server.listeners("connection")[0];
  const reloaded = await import(
    `../src/lib/subagent-rpc.ts?reload=${Date.now()}`
  );
  assert.equal(await reloaded.ensureSubagentRpc(), endpoint);
  assert.equal(state().server.listeners("connection").length, 1);
  assert.notEqual(state().server.listeners("connection")[0], listener);
  assert(state().server.listenerCount("error") > 0);
  const socket = createConnection(endpoint);
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    reply += chunk;
  });
  await once(socket, "connect");
  socket.write(JSON.stringify({ version: "invalid-reload-test" }) + "\n");
  await once(socket, "close");
  assert.match(reply, /invalid subagent RPC request/);
  console.log(
    "PASS real RPC server keeps endpoint and rebinds new module handler after reload",
  );
} finally {
  observation?.finish(null, true);
  release();
  await stopSubagentRpc();
  for (const [key, value] of runtimeEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
}
