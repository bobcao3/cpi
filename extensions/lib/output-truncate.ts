/** Contract: truncated body excludes the caller-appended closing marker and persistence suffix. */

import { truncateTail } from "@earendil-works/pi-coding-agent";

export interface OutputTruncation {
  maxLines: number;
}

export interface TruncateResult {
  truncated: boolean;
  body: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function fmtSize(b: number): string {
  return b < 1024
    ? `${b}B`
    : b < 1048576
      ? `${(b / 1024).toFixed(1)}KB`
      : `${(b / 1048576).toFixed(1)}MB`;
}

export function truncateOutput(
  acc: string,
  truncation: OutputTruncation,
  maxBytes: number,
  emptyText = "(no output)",
): TruncateResult {
  assert(typeof acc === "string", "truncateOutput: acc must be a string");
  assert(
    truncation !== null && typeof truncation === "object",
    "truncateOutput: truncation must be an object",
  );
  assert(
    Number.isInteger(truncation.maxLines) && truncation.maxLines > 0,
    "truncateOutput: truncation.maxLines invalid",
  );
  assert(
    Number.isInteger(maxBytes) && maxBytes > 0,
    "truncateOutput: maxBytes must be a positive int",
  );

  const limits = { maxBytes, maxLines: truncation.maxLines };
  const snap = truncateTail(acc, limits);
  if (!snap.truncated)
    return { truncated: false, body: snap.content || emptyText };

  const total = snap.totalLines;
  const start = total - snap.outputLines + 1;
  let body = snap.content + `\n\n[L${start}-${total}/${total}`;
  if (snap.lastLinePartial) {
    const lastNl = acc.lastIndexOf("\n");
    const tailLine = lastNl === -1 ? acc : acc.slice(lastNl + 1);
    body += ` (${fmtSize(snap.outputBytes)} tail, L=${fmtSize(Buffer.byteLength(tailLine, "utf-8"))})`;
  } else if (snap.truncatedBy === "bytes") {
    body += ` (${fmtSize(maxBytes)} cap)`;
  }
  return { truncated: true, body };
}
