import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import {
  ensureSubagentRpc,
  stopSubagentRpc,
} from "../extensions/lib/subagent-rpc.ts";
import { listActivities } from "../extensions/lib/activity.ts";

const directory = mkdtempSync(join(tmpdir(), "cpi-worker-backpressure-"));
const childRuntime = process.env.SUBAGENT_CHILD_RUNTIME || process.execPath;
const agent = join(directory, "agent");
mkdirSync(agent);
const extension = join(directory, "diagnostics.ts");
writeFileSync(
  extension,
  `export default function(pi) {
  pi.on("session_start", async () => {
    for (const [stream, text] of [[process.stdout, "O"], [process.stderr, "E"]]) {
      await new Promise((resolve, reject) => stream.write(text.repeat(524288), error => error ? reject(error) : resolve()));
    }
  });
  pi.on("input", () => ({ action: "handled" }));
}`,
);
writeFileSync(
  join(agent, "settings.json"),
  JSON.stringify({
    extensions: [extension],
    defaultProvider: "openai",
    defaultModel: "gpt-5",
    compaction: { enabled: false },
  }),
);
delete process.env.CPI_SUBAGENT_RPC;
const endpoint = await ensureSubagentRpc();
const child = spawn(childRuntime, [resolve("bin/subagent.js")], {
  cwd: directory,
  env: {
    ...process.env,
    PI_CODING_AGENT_DIR: agent,
    PI_SESSION_DIR: directory,
    CPI_SUBAGENT_RPC: endpoint,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const timeout = setTimeout(() => child.kill("SIGKILL"), 30000);
const counts = { stdout: 0, stderr: 0 };
function consume(stream, name, marker) {
  stream.on("data", (chunk) => {
    counts[name] += chunk.filter(
      (byte) => byte === marker.charCodeAt(0),
    ).length;
    stream.pause();
    setTimeout(() => stream.resume(), 25);
  });
}
consume(child.stdout, "stdout", "O");
consume(child.stderr, "stderr", "E");
child.stdin.end("DIAGNOSTIC_TRANSPORT_ONLY\n");
try {
  const [code] = await once(child, "close");
  assert.equal(code, 0, JSON.stringify(counts));
  assert.equal(counts.stdout, 524288);
  assert.equal(counts.stderr, 524288);
  const activity = listActivities().find((entry) => entry.kind === "subagent");
  assert.equal(activity.status, "completed");
  assert.equal(readFileSync(activity.log_path, "utf8"), "");
  assert.equal(activity.tail, undefined);
  const diagnostics = readFileSync(activity.metrics.diagnostics_path, "utf8");
  assert.equal(diagnostics, "E".repeat(524288));
  console.log(
    "PASS real SDK Worker and CLI slow stdout/stderr consumers; diagnostics never become conversation",
    counts,
    directory,
  );
} finally {
  clearTimeout(timeout);
  await stopSubagentRpc();
}
const framingDir = mkdtempSync(join(tmpdir(), "cpi-worker-framing-"));
const socketPath = join(framingDir, "rpc.sock");
const unicodeText = "stdout-é中🦊-tail";
const errorMessage = "Provider error: 中文-🦊";
const rpcFrame = (value) =>
  Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
let connectionCount = 0;
const server = createServer((socket) => {
  const connection = connectionCount++;
  if (connection === 0) {
    const stdoutFrame = rpcFrame({
      kind: "data",
      stream: "stdout",
      data: Buffer.from(unicodeText).toString("base64"),
    });
    socket.write(stdoutFrame.subarray(0, 40));
    socket.write(stdoutFrame.subarray(40));
    socket.end(rpcFrame({ kind: "done", exitCode: 0 }));
  } else if (connection === 1) {
    const errFrame = rpcFrame({ kind: "error", message: errorMessage });
    const split = errFrame.indexOf("中") + 1;
    socket.write(errFrame.subarray(0, split));
    socket.end(errFrame.subarray(split));
  } else {
    socket.end(
      rpcFrame({
        kind: "data",
        stream: "stderr",
        data: Buffer.alloc(300 * 1024, 0x45).toString("base64"),
      }),
    );
  }
});
server.listen(socketPath);
await once(server, "listening");
for (let i = 0; i < 3; i++) {
  const child = spawn(childRuntime, [resolve("bin/subagent.js")], {
    cwd: directory,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agent,
      PI_SESSION_DIR: directory,
      CPI_SUBAGENT_RPC: socketPath,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const chunks = { stdout: [], stderr: [] };
  child.stdout.on("data", (chunk) => chunks.stdout.push(chunk));
  child.stderr.on("data", (chunk) => chunks.stderr.push(chunk));
  child.stdin.end("x\n");
  const [code] = await once(child, "close");
  const stdout = Buffer.concat(chunks.stdout).toString("utf8");
  const stderr = Buffer.concat(chunks.stderr).toString("utf8");
  if (i === 0) {
    assert.equal(code, 0);
    assert.equal(stdout, unicodeText);
  } else if (i === 1) {
    assert.equal(code, 1);
    assert.equal(stderr, errorMessage + "\n");
  } else {
    assert.equal(code, 1);
    assert.equal(stderr, "RPC response frame exceeds 256 KiB\n");
  }
}
server.unref();
server.close();
console.log("PASS framing unicode split, oversized frame");
