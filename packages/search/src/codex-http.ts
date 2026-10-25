const max_response_bytes = 4 * 1024 * 1024;

export async function codex_request(
  endpoint: "responses" | "alpha/search",
  headers: Headers,
  body: unknown,
  caller_signal: AbortSignal,
): Promise<string> {
  const signal = AbortSignal.any([caller_signal, AbortSignal.timeout(60_000)]);
  signal.throwIfAborted();
  const response = await fetch(
    `https://chatgpt.com/backend-api/codex/${endpoint}`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Codex ${endpoint} failed: HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Codex returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > max_response_bytes)
        throw new Error("Codex response exceeded byte limit");
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function http_url(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

export function responses_output(text: string): {
  output: unknown[];
  usage?: unknown;
} {
  let completed = false;
  let output: unknown[] = [];
  let usage: unknown;
  const items: unknown[] = [];
  for (const frame of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = frame
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const event = record(JSON.parse(data));
    if (
      ["error", "response.failed", "response.incomplete"].includes(
        String(event.type),
      )
    ) {
      throw new Error("Codex hosted search failed");
    }
    if (event.type === "response.output_item.done") items.push(event.item);
    if (event.type === "response.completed") {
      const response = record(event.response);
      if (
        response.error ||
        (response.status && response.status !== "completed")
      ) {
        throw new Error("Codex hosted search did not complete successfully");
      }
      completed = true;
      output = list(response.output);
      usage = response.usage;
    }
  }
  if (!completed)
    throw new Error("Codex hosted search stream ended before completion");
  return { output: output.length ? output : items, usage };
}
