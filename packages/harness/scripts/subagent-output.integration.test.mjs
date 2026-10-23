import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { connect } from "node:net";
import test from "node:test";
import { localFixture } from "./local-fixture.mjs";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import {
  captureSessionOwner,
  sessionArtifactDirectory,
} from "../src/lib/storage/owner.ts";
import {
  getSubagentRpc,
  ensureSubagentRpc,
  runSubagentWorker,
  stopSubagentRpc,
} from "../src/lib/subagent-rpc.ts";

const stdout = Buffer.alloc(2 * 1024 * 1024);
for (let index = 0; index < stdout.length; index++) stdout[index] = index % 256;
const stderr = Buffer.from([0, 255, 226, 130, 172, 10]);

test(
  "worker output preserves bytes, continuation, reload, failures, cancellation, and shutdown",
  { timeout: 30000 },
  async () => {
    let releaseFirst;
    let firstRequest;
    const held = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const started = new Promise((resolve) => {
      firstRequest = resolve;
    });
    let holdFirst = true;
    const local = await localFixture(async (body) => {
      if (holdFirst) {
        holdFirst = false;
        firstRequest();
        await held;
      }
      return {
        content: JSON.stringify(body.messages.at(-1).content).includes("SECOND")
          ? "SECOND"
          : "FIRST",
      };
    });
    const { SessionManager } = await hostCodingAgent();
    const manager = SessionManager.create(
      local.directory,
      join(local.directory, "sessions"),
    );
    const ownerA = captureSessionOwner(manager);
    let ownerB;
    const target = join(local.directory, "existing.txt");
    await writeFile(target, "unchanged");
    const extension = join(local.directory, "output.mjs");
    await writeFile(join(local.directory, "stdout.bin"), stdout);
    await writeFile(
      extension,
      `import { readFileSync, writeFileSync } from "node:fs";
import { writeTool } from ${JSON.stringify(new URL("../src/llm-editor/tool.ts", import.meta.url).href)};
import { captureSessionOwner } from ${JSON.stringify(new URL("../src/lib/storage/owner.ts", import.meta.url).href)};
export default function(pi) {
  pi.on("session_shutdown", async (_event, ctx) => {
    if (!process.env.CPI_OWNER_PROOF) return;
    const owner = captureSessionOwner(ctx.sessionManager);
    const result = await writeTool.execute("owner-proof", {path:${JSON.stringify(target)},file_text:"worker recovery"},undefined,undefined,ctx);
    writeFileSync(process.env.CPI_OWNER_PROOF,JSON.stringify({owner,childId:ctx.sessionManager.getSessionId(),recovery:result.details.tempPath}));
  });
  pi.on("session_start", () => {
    const bytes = readFileSync(${JSON.stringify(join(local.directory, "stdout.bin"))});
    process.stdout.write(bytes.subarray(0, 3));
    process.stdout.write(bytes.subarray(3), () => process.stdout.write("callback\\n"));
    process.stderr.write(Buffer.from(${JSON.stringify([...stderr])}));
    process.stderr.write("caf", "utf8");
    process.stderr.write("e9", "hex");
    console.error("diagnostic");
    if (process.env.CPI_OUTPUT_EXIT) process.exit(0);
  });
}`,
    );
    const request = () => ({
      version: 1,
      kind: "session",
      runId: randomUUID(),
      cwd: local.directory,
      env: { ...process.env },
      extensionPaths: [extension],
      tools: ["read"],
      systemPrompt: "Reply concisely.",
      task: "Reply FIRST.",
      provider: "local-fixture",
      modelId: "fixture",
      thinkingLevel: "off",
      maxTurns: 2,
      maxOutputBytes: 4096,
    });
    try {
      const output = [];
      const diagnostics = [];
      const events = [];
      const inputA = request();
      const proofA = join(local.directory, "owner-a.json");
      const proofB = join(local.directory, "owner-b.json");
      inputA.env.CPI_OWNER_PROOF = proofA;
      inputA.env.PI_SESSION_DIR = join(local.directory, "wrong-owner");
      const pendingA = runSubagentWorker(inputA, {
        owner: ownerA,
        signal: AbortSignal.timeout(10000),
        stdout: (chunk) => output.push(chunk),
        stderr: (chunk) => diagnostics.push(chunk),
        onEvent: (event) => events.push(event),
        onMessage: (candidate) =>
          candidate.turn === 0
            ? { kind: "continue", prompt: "Reply SECOND." }
            : { kind: "finish" },
      });
      await Promise.race([
        started,
        pendingA.then((result) => {
          throw (
            result.error ??
            new Error("worker finished before reaching the request gate")
          );
        }),
      ]);
      manager.newSession();
      ownerB = captureSessionOwner(manager);
      await ensureSubagentRpc(ownerB);
      const inputB = request();
      inputB.env.CPI_OWNER_PROOF = proofB;
      inputB.env.PI_SESSION_DIR = inputA.env.PI_SESSION_DIR;
      const resultB = await runSubagentWorker(inputB, {
        owner: ownerB,
        signal: AbortSignal.timeout(10000),
        onMessage: () => ({ kind: "finish" }),
      });
      assert.equal(resultB.error, undefined);
      assert.equal(resultB.exitCode, 0);
      releaseFirst();
      const result = await pendingA;
      for (const [owner, proof, ownedResult] of [
        [ownerA, proofA, result],
        [ownerB, proofB, resultB],
      ]) {
        const recorded = JSON.parse(await readFile(proof, "utf8"));
        assert.deepEqual(recorded.owner, owner);
        assert.notEqual(recorded.childId, owner.session_id);
        assert.ok(
          !relative(
            sessionArtifactDirectory(owner, "subagent-transcripts"),
            ownedResult.observation.markdownPath,
          ).startsWith(".."),
        );
        assert.ok(
          !relative(
            sessionArtifactDirectory(owner, "write-recovery"),
            recorded.recovery,
          ).startsWith(".."),
        );
        assert.equal(
          await readFile(recorded.recovery, "utf8"),
          "worker recovery",
        );
      }
      assert.equal(await readFile(target, "utf8"), "unchanged");
      assert.equal(result.error, undefined);
      assert.equal(result.exitCode, 0);
      assert.equal(result.observation.finalAnswer, "SECOND");
      assert.deepEqual(
        Buffer.concat(output),
        Buffer.concat([stdout, Buffer.from("callback\n")]),
      );
      const diagnostic = Buffer.concat([
        stderr,
        Buffer.from("caf"),
        Buffer.from([233]),
        Buffer.from("diagnostic\n"),
      ]);
      const diagnosticBytes = Buffer.concat(diagnostics);
      const diagnosticStart = diagnosticBytes.indexOf(stderr);
      assert.ok(diagnosticStart >= 0);
      assert.deepEqual(
        diagnosticBytes.subarray(
          diagnosticStart,
          diagnosticStart + diagnostic.length,
        ),
        diagnostic,
      );
      assert.deepEqual(
        await readFile(result.observation.diagnosticsPath),
        Buffer.concat(diagnostics),
      );
      assert.equal(events.at(-2).type, "usage");
      assert.equal(events.at(-1).outcome, "completed");
      assert.equal(
        events.filter((event) => event.type === "terminal").length,
        1,
      );
      const settingsPath = join(local.agentDir, "settings.json");
      const settings = JSON.parse(await readFile(settingsPath, "utf8"));
      await writeFile(
        settingsPath,
        JSON.stringify({ ...settings, extensions: [extension] }),
      );
      const endpoint = getSubagentRpc();
      assert.ok(endpoint);
      assert.equal(await ensureSubagentRpc(), endpoint);
      const socket = connect(endpoint);
      const messages = [];
      try {
        await new Promise((resolve, reject) => {
          let pending = "";
          socket.setTimeout(10000, () =>
            socket.destroy(new Error("output RPC stalled")),
          );
          socket.on("error", reject);
          socket.on("end", resolve);
          socket.on("data", (chunk) => {
            pending += chunk;
            let newline;
            while ((newline = pending.indexOf("\n")) !== -1) {
              try {
                messages.push(JSON.parse(pending.slice(0, newline)));
              } catch (error) {
                reject(error);
                socket.destroy();
                return;
              }
              pending = pending.slice(newline + 1);
            }
          });
          socket.write(
            `${JSON.stringify({
              version: 1,
              argv: ["-m", "local-fixture/fixture:off"],
              task: "Reply FIRST.",
              cwd: local.directory,
              env: { ...process.env },
              runId: randomUUID(),
            })}\n`,
          );
        });
      } finally {
        socket.destroy();
        await writeFile(settingsPath, JSON.stringify(settings));
      }
      assert.equal(
        messages.some((message) => message.kind === "error"),
        false,
      );
      assert.equal(messages.at(-1).exitCode, 0);
      const forwarded = (stream) =>
        Buffer.concat(
          messages
            .filter(
              (message) => message.kind === "data" && message.stream === stream,
            )
            .map((message) => Buffer.from(message.data, "base64")),
        );
      assert.deepEqual(
        forwarded("stdout"),
        Buffer.concat([stdout, Buffer.from("callback\nFIRST\n")]),
      );
      const forwardedDiagnostics = forwarded("stderr");
      const forwardedStart = forwardedDiagnostics.indexOf(stderr);
      assert.ok(forwardedStart >= 0);
      assert.deepEqual(
        forwardedDiagnostics.subarray(
          forwardedStart,
          forwardedStart + diagnostic.length,
        ),
        diagnostic,
      );
      await stopSubagentRpc();
      await stopSubagentRpc();

      for (const mode of [
        "callback",
        "exit",
        "cancel",
        "shutdown",
        "startup",
      ]) {
        const input = request();
        if (mode === "exit") input.env.CPI_OUTPUT_EXIT = "1";
        if (mode === "startup") input.provider = "missing-output-provider";
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const events = [];
        let shutdown;
        let consumerCalls = 0;
        const pending = runSubagentWorker(input, {
          owner: ownerB,
          signal: controller.signal,
          stdout: () => {
            if (mode === "callback") {
              consumerCalls++;
              throw new Error("output consumer failed");
            }
            if (mode === "cancel") controller.abort();
          },
          onEvent: (event) => events.push(event),
          onMessage: () => {
            if (mode === "shutdown") shutdown = stopSubagentRpc();
            return mode === "shutdown" ? undefined : { kind: "finish" };
          },
        });
        const result = await pending;
        clearTimeout(timer);
        await shutdown;
        assert.equal(events.at(-2).type, "usage", mode);
        assert.equal(events.at(-1).type, "terminal", mode);
        assert.equal(
          events.filter((event) => event.type === "terminal").length,
          1,
          mode,
        );
        if (mode === "cancel" || mode === "shutdown") {
          assert.equal(events.at(-1).outcome, "cancelled", mode);
          assert.equal(result.error, undefined, mode);
        } else {
          assert.equal(events.at(-1).outcome, "failed", mode);
          assert.equal(result.exitCode, 1, mode);
          if (mode === "callback") {
            assert.match(result.error.message, /output consumer failed/);
            assert.equal(consumerCalls, 1);
          }
          if (mode === "startup")
            assert.ok(
              (await readFile(result.observation.diagnosticsPath)).length > 0,
            );
        }
        await stopSubagentRpc();
        await stopSubagentRpc();
      }
    } finally {
      releaseFirst();
      await stopSubagentRpc();
      await local.close();
    }
  },
);
