import { createServer } from "node:http";
import { zstdDecompressSync } from "node:zlib";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isolateAgent } from "./test-runtime.mjs";
import "./fast-host-fixture.mjs";
import { hostCodingAgent } from "../bin/host-pi.mjs";
import {
  initializeFastModels,
  installFastModels,
} from "../bin/fast-models.mjs";

const { ModelRuntime, CONFIG_DIR_NAME } = await hostCodingAgent();
installFastModels(ModelRuntime);

export async function fixture(
  run,
  inputTokens = 100,
  beforeReply,
  responseItem,
) {
  const directory = await mkdtemp(join(tmpdir(), "cpi-fast-"));
  const restore = isolateAgent(directory);
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
    await beforeReply?.();
    response.writeHead(200, { "content-type": "text/event-stream" });
    const item = responseItem?.(requests) ?? {
      type: "message",
      id: "msg_test",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    };
    if (item.type === "error") {
      response.end(`event: error\ndata: ${JSON.stringify(item)}\n\n`);
      return;
    }
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
    const events =
      item.type === "function_call"
        ? [
            {
              type: "response.output_item.added",
              output_index: 0,
              item: { ...item, arguments: "" },
            },
            {
              type: "response.function_call_arguments.delta",
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            },
            { type: "response.output_item.done", output_index: 0, item },
            event,
          ]
        : [
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
  const defaults = JSON.parse(
    await readFile(
      new URL("../cpi-config.default.json", import.meta.url),
      "utf8",
    ),
  ).fast;
  await mkdir(join(directory, CONFIG_DIR_NAME));
  await writeFile(
    join(directory, CONFIG_DIR_NAME, "cpi-config.json"),
    JSON.stringify({
      fast: {
        models: [
          ...new Set([
            ...defaults.models,
            ...Object.keys(defaults.costMultipliers),
          ]),
        ],
      },
    }),
  );
  const config = {
    providers: Object.fromEntries(
      defaults.providers.map((id) => [id, { baseUrl, apiKey }]),
    ),
  };
  await writeFile(modelsPath, JSON.stringify(config));
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath: join(directory, "auth.json"),
  });
  await initializeFastModels(runtime, directory);
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
    restore();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}
