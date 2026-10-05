import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  const result =
    method === "initialize"
      ? {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "tree-fixture", version: "1" },
        }
      : method === "tools/list"
        ? {
            tools: [
              {
                name: "report",
                inputSchema: {
                  type: "object",
                  properties: {
                    large: { type: "boolean" },
                    error: { type: "boolean" },
                  },
                },
                outputSchema: {
                  type: "object",
                  properties: {
                    marker: { type: "string" },
                    enabled: { type: "boolean" },
                  },
                },
              },
            ],
          }
        : method === "tools/call"
          ? {
              content: [
                {
                  type: "text",
                  text: params.arguments?.large
                    ? "MCP_MODEL_TEXT\n".repeat(3000)
                    : "MCP_MODEL_TEXT",
                },
              ],
              structuredContent: { marker: "MCP_TYPED_ONLY", enabled: false },
              isError: params.arguments?.error === true,
            }
          : {};
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
});
