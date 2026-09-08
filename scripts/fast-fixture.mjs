import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function fixture(run, inputTokens = 100) {
  const directory = await mkdtemp(join(tmpdir(), "cpi-fast-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body =
      request.headers["content-encoding"] === "zstd"
        ? zstdDecompressSync(bytes)
        : bytes;
    requests.push({
      url: request.url,
      headers: request.headers,
      body: JSON.parse(body.toString()),
    });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    };
    const event = {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        service_tier: "priority",
        output: [item],
        usage: {
          input_tokens: inputTokens,
          output_tokens: 10,
          input_tokens_details: { cached_tokens: 20 },
          total_tokens: inputTokens + 10,
        },
      },
    };
    const events = [
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { ...item, content: [] },
      },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: "OK",
      },
      event,
    ];
    response.end(
      events
        .map(
          (entry) => `event: ${entry.type}\ndata: ${JSON.stringify(entry)}\n\n`,
        )
        .join(""),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
  const modelsPath = join(directory, "models.json");
  const config = {
    providers: Object.fromEntries(
      ["openai", "openai-codex"].map((id) => [id, { baseUrl, apiKey }]),
    ),
  };
  await writeFile(modelsPath, JSON.stringify(config));
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(directory, "auth.json"),
  });
  try {
    await run({
      runtime,
      requests,
      modelsPath,
      config,
      baseUrl,
      apiKey,
      directory,
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
