export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export async function response_text(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  if (!response.body) throw new Error("Empty response body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new Error("Response exceeds byte limit");
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function json_request(
  url: string | URL,
  init: RequestInit,
): Promise<unknown> {
  return JSON.parse(
    await response_text(await fetch(url, { ...init, redirect: "error" })),
  );
}

export function public_url(value: string): URL {
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Expected an HTTP(S) URL without credentials");
  return url;
}
