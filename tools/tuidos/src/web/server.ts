import {
  createSecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
  type Http2SecureServer,
} from "node:http2";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { adapterErrorResponse } from "./security";

const BODY_LIMIT = 1_048_576;
const MAX_RESPONSE_BYTES = 1 * 1024 * 1024 * 1024;
const MAX_RESPONSE_CHUNKS = 262_144;
class RequestBodyTooLarge extends Error {}
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
]);

type WebRequest = Http2ServerRequest | IncomingMessage;
type WebResponse = Http2ServerResponse | ServerResponse;

async function requestBody(
  request: WebRequest,
): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    length += bytes.byteLength;
    if (length > BODY_LIMIT)
      throw new RequestBodyTooLarge(
        "request body exceeds the 1 MiB server limit",
      );
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function requestHeaders(request: WebRequest): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(request.headers)) {
    if (name.startsWith(":") || raw == null) continue;
    if (Array.isArray(raw)) raw.forEach((value) => headers.append(name, value));
    else headers.set(name, String(raw));
  }
  return headers;
}

async function toFetchRequest(request: WebRequest): Promise<Request> {
  const authority = request.headers[":authority"] ?? request.headers.host;
  if (!authority) throw new Error("request has no authority");
  const pathname = request.url?.startsWith("/") ? request.url : "/";
  const body = await requestBody(request);
  return new Request(`https://${authority}${pathname}`, {
    method: request.method,
    headers: requestHeaders(request),
    body,
  });
}

async function writeResponse(
  target: WebResponse,
  response: Response,
  method: string | undefined,
): Promise<void> {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (!HOP_HEADERS.has(name.toLowerCase())) target.setHeader(name, value);
  });
  if (method === "HEAD" || response.body == null) {
    target.end();
    return;
  }
  const reader = response.body.getReader();
  let totalBytes = 0;
  let totalChunks = 0;
  const writable = target as { write(chunk: Uint8Array): boolean };
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      target.end();
      return;
    }
    totalBytes += value.byteLength;
    totalChunks += 1;
    if (totalBytes > MAX_RESPONSE_BYTES || totalChunks > MAX_RESPONSE_CHUNKS) {
      await reader.cancel();
      throw new Error("response exceeds the server limit");
    }
    if (!writable.write(Buffer.from(value))) await once(target, "drain");
  }
}

export interface WebServer {
  readonly port: number;
  close: () => Promise<void>;
}

export async function startWebServer(options: {
  hostname: string;
  port: number;
  cert: string;
  key: string;
  fetch: (request: Request) => Response | Promise<Response>;
}): Promise<WebServer> {
  const server: Http2SecureServer = createSecureServer(
    {
      cert: options.cert,
      key: options.key,
      allowHTTP1: true,
      maxSessionMemory: 16,
      maxHeaderListPairs: 128,
      settings: { maxConcurrentStreams: 128 },
    },
    (request, response) => {
      void (async () => {
        try {
          const fetchRequest = await toFetchRequest(request);
          const fetchResponse = await options.fetch(fetchRequest);
          await writeResponse(response, fetchResponse, request.method);
        } catch (error) {
          if (!response.headersSent) {
            try {
              await writeResponse(
                response,
                adapterErrorResponse(error instanceof RequestBodyTooLarge),
                request.method,
              );
            } catch {
              response.destroy();
            }
          } else {
            response.destroy();
          }
        }
      })();
    },
  );
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.maxConnections = 128;
  server.setTimeout(65_000);
  server.on("sessionError", () => {});
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(options.port, options.hostname, () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("web server did not expose a bound address");
  }
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(() => {
          for (const socket of sockets) socket.destroy();
          resolve();
        }, 2_000).unref();
      }),
  };
}
