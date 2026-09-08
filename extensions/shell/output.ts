import {
  truncateOutput,
  type OutputTruncation,
} from "../lib/output-truncate.ts";
export type { OutputTruncation };
import type { BackgroundChild } from "./background-types.ts";
export function accumulateOutput(entry: BackgroundChild, buf: Buffer, off: number, maxAcc: number): void {
  entry.acc += entry.decoder.write(buf);
  entry.bytesEmitted = off + buf.length;
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl === -1) entry.colBytes += buf.length;
  else {
    entry.linesEmitted += buf.subarray(0, lastNl).filter((b) => b === 0x0a).length + 1;
    entry.colBytes = buf.length - 1 - lastNl;
  }
  if (Buffer.byteLength(entry.acc) > maxAcc) {
    while (Buffer.byteLength(entry.acc) > maxAcc)
      entry.acc = entry.acc.slice(Math.max(1, Math.ceil(entry.acc.length * 0.1)));
    const c0 = entry.acc.charCodeAt(0);
    if (c0 >= 0xdc00 && c0 <= 0xdfff) entry.acc = entry.acc.slice(1);
  }
}
export interface ShellTunables {
  previewMaxBytes: number;
  maxAcc: number;
  updateMs: number;
}
export interface OutputCursor {
  line: number;
  column: number;
  bytes: number;
}
export interface ShResult {
  id: string | null;
  status: "completed" | "running";
  exitCode: number | null;
  text: string;
  fullOutputPath?: string;
  cursor?: OutputCursor;
}
export async function buildOutputText(
  acc: string,
  opts: {
    persistIfTruncated?: boolean;
    emptyText?: string;
    logPath?: string;
    truncation: OutputTruncation;
    tunables: ShellTunables;
  },
): Promise<{ text: string; fullOutputPath?: string }> {
  const {
    persistIfTruncated = true,
    emptyText = "(no output)",
    logPath,
    truncation,
    tunables,
  } = opts;
  const out = truncateOutput(
    acc,
    truncation,
    tunables.previewMaxBytes,
    emptyText,
  );
  if (!out.truncated) return { text: out.body };
  let full: string | undefined;
  let text = out.body;
  if (persistIfTruncated) {
    full = logPath;
    text += ` full: ${full}`;
  }
  return { text: text + "]", fullOutputPath: full };
}
