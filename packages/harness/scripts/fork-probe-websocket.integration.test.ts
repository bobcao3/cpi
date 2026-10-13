import "@cpi/cli/bootstrap";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import { runForkProbe } from "../src/lib/fork-probe.ts";
import { stopSubagentRpc } from "../src/lib/subagent-rpc.ts";
import { isolateAgent } from "./test-runtime.mjs";

test("fork probe releases a cached WebSocket under its inherited request identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpi-probe-websocket-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir);
  const restore = isolateAgent(agentDir);
  const requests: { prompt_cache_key: string; input: unknown[] }[] = [];
  let closed = 0;
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
    expect(result.ok).toBe(true);
    expect(result.answer).toBe("PROBE_OK");
    expect(performance.now() - started).toBeLessThan(8000);
    expect(requests).toHaveLength(1);
    expect(requests[0].prompt_cache_key).toBe(parent.getSessionId());
    expect(JSON.stringify(requests[0].input)).not.toContain("AFTER_SNAPSHOT");
    expect(closed).toBe(1);
  } finally {
    await stopSubagentRpc();
    server.stop(true);
    restore();
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
