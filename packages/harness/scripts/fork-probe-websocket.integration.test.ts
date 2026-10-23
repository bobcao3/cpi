import "@cpi/cli/bootstrap";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { runForkProbe } from "../src/lib/fork-probe.ts";
import { stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { state } from "../src/lib/subagent-rpc-runtime.ts";
import { finish_storage_operations } from "../src/lib/storage/operations.ts";
import { isolateAgent } from "./test-runtime.mjs";

test("fork probe joins its Worker and cached WebSocket before owned scratch cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpi-probe-websocket-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const restore = isolateAgent(agentDir);
  const requests: { prompt_cache_key: string; input: unknown[] }[] = [];
  let closed = 0;
  let owned_root = "";
  let phase = "success";
  let controller = new AbortController();
  let observation_error: unknown;
  const observed: {
    directory: string;
    worker: import("node:worker_threads").Worker;
    transcript: string;
    present_at_exit: boolean;
    exited: boolean;
  }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("Expected WebSocket transport", { status: 500 });
    },
    websocket: {
      message(socket, message) {
        requests.push(JSON.parse(String(message)));
        try {
          const directories = readdirSync(owned_root);
          expect(directories).toHaveLength(1);
          const directory = join(owned_root, directories[0]);
          expect(statSync(directory).isDirectory()).toBe(true);
          if (process.platform !== "win32")
            expect(statSync(directory).mode & 0o077).toBe(0);
          expect(existsSync(join(directory, "parent.snapshot"))).toBe(true);
          const runs = [...state().active];
          expect(runs).toHaveLength(1);
          const record = {
            directory,
            worker: runs[0].worker,
            transcript: runs[0].observation.result.markdownPath,
            present_at_exit: false,
            exited: false,
          };
          observed.push(record);
          record.worker.once("exit", () => {
            record.exited = true;
            record.present_at_exit = existsSync(directory);
          });
          if (phase === "cleanup-failure") chmodSync(owned_root, 0o500);
        } catch (error) {
          observation_error = error;
        }
        if (phase === "cancel") {
          controller.abort();
          return;
        }
        for (const event of [
          { type: "response.created", response: { id: "probe-response" } },
          {
            type: "response.output_item.added",
            item: {
              type: "message",
              id: "msg",
              role: "assistant",
              content: [],
            },
          },
          {
            type: "response.content_part.added",
            part: { type: "output_text", text: "" },
          },
          { type: "response.output_text.delta", delta: "PROBE_OK" },
          {
            type: "response.completed",
            response: {
              id: "probe-response",
              status: "completed",
              usage: { input_tokens: 1, output_tokens: 3, total_tokens: 4 },
            },
          },
        ])
          socket.send(JSON.stringify(event));
      },
      close() {
        closed++;
      },
    },
  });
  const token = `fixture.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture" } })).toString("base64")}.fixture`;
  try {
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          local: {
            baseUrl: `http://127.0.0.1:${server.port}`,
            api: "openai-codex-responses",
            apiKey: token,
            models: [
              {
                id: "probe",
                name: "probe",
                reasoning: true,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 1024,
                cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: "local",
        defaultModel: "probe",
        transport: "websocket-cached",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const { SessionManager } = await hostCodingAgent();
    const parent = SessionManager.create(root, join(root, "sessions"));
    parent.appendModelChange("local", "probe");
    parent.appendMessage({
      role: "user",
      content: "Test cached probe cleanup.",
      timestamp: Date.now(),
    });
    owned_root = join(
      parent.getSessionDir(),
      "artifacts",
      createHash("sha256").update(parent.getSessionId()).digest("hex"),
      "fork-probes",
    );
    const started = performance.now();
    const pending = runForkProbe(
      {
        parentSessionFile: parent.getSessionFile()!,
        cwd: root,
        timeoutMs: 8000,
      },
      "Describe your status.",
    );
    parent.appendMessage({
      role: "user",
      content: "AFTER_SNAPSHOT",
      timestamp: Date.now(),
    });
    const result = await pending;
    expect(observation_error).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("PROBE_OK");
    expect(performance.now() - started).toBeLessThan(8000);
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt_cache_key).toBe(parent.getSessionId());
    expect(JSON.stringify(requests[0].input)).not.toContain("AFTER_SNAPSHOT");
    expect(closed).toBe(1);
    expect(observed[0].exited).toBe(true);
    expect(observed[0].present_at_exit).toBe(true);
    expect(observed[0].worker.threadId).toBe(-1);
    expect(existsSync(observed[0].directory)).toBe(false);
    expect(existsSync(observed[0].transcript)).toBe(true);
    const options = {
      parentSessionFile: parent.getSessionFile()!,
      cwd: root,
      timeoutMs: 8000,
    };
    for (phase of [
      "cancel",
      "retained",
      ...(process.platform !== "win32" && process.getuid?.() !== 0
        ? ["cleanup-failure"]
        : []),
    ]) {
      controller = new AbortController();
      const result = await runForkProbe(
        {
          ...options,
          signal: controller.signal,
          ephemeral: phase !== "retained",
        },
        "Describe your status.",
      );
      if (phase === "cleanup-failure") chmodSync(owned_root, 0o700);
      expect(observation_error).toBeUndefined();
      const record = observed.at(-1)!;
      expect(record.exited).toBe(true);
      expect(record.present_at_exit).toBe(true);
      expect(record.worker.threadId).toBe(-1);
      expect(existsSync(record.transcript)).toBe(true);
      expect(result.ok).toBe(phase === "retained");
      expect(existsSync(record.directory)).toBe(phase !== "cancel");
      if (phase === "cancel") expect(result.errorMessage).toContain("aborted");
      if (phase === "retained")
        expect(
          readdirSync(record.directory).some((name) => name.endsWith(".jsonl")),
        ).toBe(true);
      if (phase === "cleanup-failure") {
        expect(result.answer).toBe("PROBE_OK");
        expect(result.exitCode).toBe(0);
        expect(result.errorMessage).toContain(record.directory);
        expect(
          (await finish_storage_operations(AbortSignal.timeout(5000))).pending,
        ).toEqual([]);
        expect(existsSync(record.directory)).toBe(false);
      }
      await rm(record.directory, { recursive: true, force: true });
      expect(readdirSync(owned_root)).toHaveLength(0);
    }
    const parent_file = options.parentSessionFile;
    const parent_bytes = readFileSync(parent_file);
    const request_count = requests.length;
    const failed_setup = runForkProbe(options, "Describe your status.");
    unlinkSync(parent_file);
    let failed;
    try {
      failed = await failed_setup;
    } finally {
      writeFileSync(parent_file, parent_bytes);
    }
    expect(failed.ok).toBe(false);
    expect(failed.errorMessage).toContain("ENOENT");
    expect(requests).toHaveLength(request_count);
    expect(state().active.size).toBe(0);
    expect(readdirSync(owned_root)).toHaveLength(0);
    expect(closed).toBe(request_count);
  } finally {
    if (owned_root && existsSync(owned_root)) chmodSync(owned_root, 0o700);
    await stopSubagentRpc();
    server.stop(true);
    restore();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
