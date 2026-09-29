import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connect } from "node:net";

export interface NativeStatus {
  uid: string;
  pid: number;
  bytes: number;
  exit_code: number | null;
  is_pty: boolean;
}
export interface NativeResponse {
  version: number;
  ok: boolean;
  server_pid: number;
  session?: NativeStatus | null;
  sessions?: NativeStatus[] | null;
  error_name?: string | null;
}
export function ghostmuxRequest(
  socketPath: string,
  request: Record<string, unknown>,
  signal?: AbortSignal,
  binaryPath?: string,
): Promise<NativeResponse> {
  signal?.throwIfAborted();
  if (process.platform === "win32") {
    if (
      !binaryPath ||
      !["list_sessions", "kill_session", "signal_session"].includes(
        String(request.op),
      )
    )
      throw new Error("Unsupported Windows ghostmux control request");
    const args = [
      "-S",
      socketPath,
      String(request.op).replaceAll("_", "-"),
      "--json",
    ];
    for (const key of ["uid", "signal"])
      if (request[key] !== undefined)
        args.push(`--${key}`, String(request[key]));
    return promisify(execFile)(binaryPath, args, {
      signal,
      timeout: 10000,
      maxBuffer: 8 * 1024 * 1024,
    }).then(({ stdout }) => JSON.parse(stdout));
  }
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let header = Buffer.alloc(0);
    let body: Buffer | undefined;
    let offset = 0;
    let settled = false;
    const finish = (error?: Error, response?: NativeResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const abort = () => finish(new Error("ghostmux request aborted"));
    const timer = setTimeout(
      () => finish(new Error("ghostmux request timed out")),
      10000,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", (error) => finish(error));
    socket.on("close", () =>
      finish(new Error("ghostmux connection closed before response")),
    );
    socket.on("connect", () => {
      const payload = Buffer.from(JSON.stringify({ version: 1, ...request }));
      if (payload.length > 1024 * 1024) {
        finish(new Error("ghostmux request too large"));
        return;
      }
      const frame = Buffer.allocUnsafe(4 + payload.length);
      frame.writeUInt32BE(payload.length);
      payload.copy(frame, 4);
      socket.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      if (!body) {
        const needed = 4 - header.length;
        header = Buffer.concat([header, chunk.subarray(0, needed)]);
        chunk = chunk.subarray(needed);
        if (header.length < 4) return;
        const length = header.readUInt32BE();
        if (length === 0 || length > 8 * 1024 * 1024) {
          finish(new Error("invalid ghostmux response size"));
          return;
        }
        body = Buffer.allocUnsafe(length);
      }
      const count = Math.min(chunk.length, body.length - offset);
      chunk.copy(body, offset, 0, count);
      offset += count;
      if (offset === body.length) {
        try {
          const response = JSON.parse(body.toString()) as NativeResponse;
          if (response.version !== 1)
            throw new Error("ghostmux protocol version mismatch");
          finish(undefined, response);
        } catch (error) {
          finish(error as Error);
        }
      }
    });
  });
}
