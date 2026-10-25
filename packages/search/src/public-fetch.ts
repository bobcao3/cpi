import { lookup } from "node:dns/promises";
import { request as http_request } from "node:http";
import { request as https_request } from "node:https";
import { BlockList, isIP } from "node:net";
import { MAX_RESPONSE_BYTES, public_url } from "./http.ts";
import { readable_html } from "./html.ts";
import type { ProviderResult } from "./types.ts";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
const global_v6 = new BlockList();
global_v6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
blocked.addSubnet("3fff::", 20, "ipv6");

async function public_address(url: URL, signal: AbortSignal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const resolution = isIP(hostname)
    ? Promise.resolve([{ address: hostname, family: isIP(hostname) }])
    : lookup(hostname, { all: true });
  let abort: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    const addresses = await Promise.race([resolution, cancellation]);
    if (
      !addresses.length ||
      addresses.some(({ address, family }) =>
        family === 4
          ? blocked.check(address, "ipv4")
          : !global_v6.check(address, "ipv6") || blocked.check(address, "ipv6"),
      )
    )
      throw new Error("Page URL must resolve only to public addresses");
    return addresses[0];
  } finally {
    signal.removeEventListener("abort", abort!);
  }
}

async function retrieve(
  url: URL,
  signal: AbortSignal,
): Promise<{
  status: number;
  location?: string;
  type: string;
  text: string;
}> {
  signal.throwIfAborted();
  const address = await public_address(url, signal);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https_request : http_request)(
      url,
      {
        signal,
        agent: false,
        headers: {
          "user-agent": "cpi-search/0.0.6",
          "accept-encoding": "identity",
        },
        lookup: (_hostname, options, done) =>
          options.all
            ? done(null, [address])
            : done(null, address.address, address.family),
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const type = response.headers["content-type"] ?? "";
        if (status >= 300 && status < 400) {
          response.destroy();
          resolve({
            status,
            location: response.headers.location,
            type,
            text: "",
          });
          return;
        }
        if (
          status < 200 ||
          status >= 300 ||
          !/^(text\/|application\/(json|[\w.+-]*xml)\b)/i.test(type) ||
          ![undefined, "identity"].includes(
            response.headers["content-encoding"],
          )
        ) {
          response.destroy();
          reject(
            new Error(
              `Cannot retrieve page: HTTP ${status}, unsupported content, or encoding`,
            ),
          );
          return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Page exceeds byte limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status,
            type,
            text: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    request.end();
  });
}

export async function fetch_public_page(
  value: string,
  signal: AbortSignal,
): Promise<ProviderResult> {
  let url = public_url(value);
  for (let redirects = 0; redirects <= 4; redirects++) {
    const result = await retrieve(url, signal);
    if (result.status >= 300 && result.status < 400) {
      if (!result.location) throw new Error("Redirect missing Location");
      url = public_url(new URL(result.location, url).href);
      continue;
    }
    const text = /html/i.test(result.type)
      ? readable_html(result.text)
      : result.text.trim();
    if (!text) throw new Error("Page has no readable content");
    return { text, sources: [{ url: url.href }] };
  }
  throw new Error("Page exceeds redirect limit");
}
