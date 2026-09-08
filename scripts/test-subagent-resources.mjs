import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { once } from "node:events";
import { reserveTranscript } from "../extensions/lib/subagent-artifacts.ts";
import { SubagentObservation } from "../extensions/lib/subagent-observation.ts";
import {
  ensureSubagentRpc,
  stopSubagentRpc,
} from "../extensions/lib/subagent-rpc.ts";
import { state } from "../extensions/lib/subagent-rpc-runtime.ts";

const directory = mkdtempSync(join(tmpdir(), "cpi-subagent-resources-"));
const artifacts = join(directory, "subagent-transcripts");
mkdirSync(artifacts);
const active = join(artifacts, "0000000000000-active");
const release = reserveTranscript(active, artifacts);
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

  const endpoint = await ensureSubagentRpc();
  const listener = state().server.listeners("connection")[0];
  const reloaded = await import(
    `../extensions/lib/subagent-rpc.ts?reload=${Date.now()}`
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
  rmSync(directory, { recursive: true, force: true });
}
