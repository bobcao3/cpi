import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ModelRuntime } from "@cpi/cli";
import { assertLocalModel, isolateAgent } from "./test-runtime.mjs";

export async function localFixture(
  reply,
  { contextWindow = 128000, input = ["text"] } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "cpi-local-model-"));
  const agentDir = join(directory, "agent");
  await mkdir(agentDir);
  const restore = isolateAgent(agentDir);
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      requests.push(body);
      const result = await reply(body);
      const tools = result.tools?.map((tool, index) => ({
        index,
        id: `call_${requests.length}_${index}`,
        type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) },
      }));
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      const emit = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: `fixture_${requests.length}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
            usage: {
              prompt_tokens: result.inputTokens ?? 256,
              completion_tokens: 10,
              total_tokens: (result.inputTokens ?? 256) + 10,
            },
          })}\n\n`,
        );
      emit({ role: "assistant", ...(tools ? { tool_calls: tools } : {}) });
      for (const content of result.chunks ?? [result.content ?? ""]) {
        if (response.destroyed) return;
        emit({ content });
        if (result.delayMs) await delay(result.delayMs);
      }
      if (!response.destroyed) {
        emit({}, tools ? "tool_calls" : "stop");
        response.end("data: [DONE]\n\n");
      }
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "local-fixture": {
            baseUrl,
            api: "openai-completions",
            apiKey: "fixture",
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input,
                contextWindow,
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
        defaultProvider: "local-fixture",
        defaultModel: "fixture",
        defaultThinkingLevel: "off",
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const runtime = await ModelRuntime.create({
      modelsPath: join(agentDir, "models.json"),
      authPath: join(agentDir, "auth.json"),
    });
    const model = runtime.getModel("local-fixture", "fixture");
    assertLocalModel(model, baseUrl);
    return {
      directory,
      agentDir,
      runtime,
      model,
      baseUrl,
      requests,
      async close() {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        restore();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    server.closeAllConnections();
    server.close();
    restore();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
