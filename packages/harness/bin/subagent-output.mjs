import { Console } from "node:console";
import { publish } from "./subagent-events.mjs";

for (const stream of ["stdout", "stderr"]) {
  process[stream].write = (chunk, encoding, callback) => {
    if (typeof encoding === "function") callback = encoding;
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
      publish({
        type: "output",
        stream,
        data: bytes.subarray(offset, offset + 48 * 1024).toString("base64"),
      });
    }
    if (callback) queueMicrotask(() => callback());
    return true;
  };
}
globalThis.console = new Console({
  stdout: process.stdout,
  stderr: process.stderr,
});
