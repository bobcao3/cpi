/**
 * Pure output-truncation computation (R1 extraction from `shell/exec.ts`).
 *
 * Computes the agent-facing preview body for a captured stdout/stderr buffer
 * using the same `truncateHead` / `truncateTail` primitives `sh` uses. This
 * module holds ONLY the pure computation — no fs writes, no pi/ExtensionAPI
 * import — so both `shell/exec.ts` (persist-if-truncated `buildOutputText`)
 * and `lib/lsp/manager.ts` (fullCheck overflow path, §7.4) can consume it
 * without pulling shell or pi coupling into the LSP layer.
 *
 * Contract of {@link truncateOutput}:
 *   - not truncated → `body` is the full content, or `emptyText` when empty;
 *     `truncated === false`. Caller returns `body` as-is.
 *   - truncated → `body` is `content + "\n\n[L…]"` (with any ` (… cap)` /
 *     `(… tail, L=…)` suffix), WITHOUT the trailing `]` and WITHOUT the
 *     ` full: <path>` overflow line. The caller appends those: the persist
 *     path is impure (fs write + session/log dir), so it stays out of here.
 */

import { truncateHead, truncateTail } from "@earendil-works/pi-coding-agent";

/** Direction + line budget for preview truncation. */
export interface OutputTruncation {
  mode: "head" | "tail";
  maxLines: number;
}

/** Result of {@link truncateOutput}. */
export interface TruncateResult {
  /** True iff the source exceeded the line or byte limit. */
  truncated: boolean;
  /**
   * Preview body (see module contract). When `truncated` is false this is the
   * full content (or `emptyText`); when true it is the truncated content plus
   * the `[L…` annotation, awaiting the caller's ` full: …]` suffix.
   */
  body: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Human-readable byte size, matching the pre-extraction `sh` annotation. */
function fmtSize(b: number): string {
  return b < 1024
    ? `${b}B`
    : b < 1048576
      ? `${(b / 1024).toFixed(1)}KB`
      : `${(b / 1048576).toFixed(1)}MB`;
}

/**
 * Compute the truncated preview body for `acc` under `truncation` and a
 * `maxBytes` cap (whichever is hit first wins, per `truncateHead/Tail`).
 *
 * Pure: no I/O. The caller decides persistence — if `truncated`, append
 * ` full: <logPath>` and a closing `]` (and write the overflow log) as needed,
 * mirroring `shell/exec.ts` `buildOutputText`.
 */
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
    (truncation.mode === "head" || truncation.mode === "tail") &&
      Number.isInteger(truncation.maxLines) &&
      truncation.maxLines > 0,
    "truncateOutput: truncation.{mode,maxLines} invalid",
  );
  assert(
    Number.isInteger(maxBytes) && maxBytes > 0,
    "truncateOutput: maxBytes must be a positive int",
  );

  const limits = { maxBytes, maxLines: truncation.maxLines };
  const snap = truncation.mode === "head" ? truncateHead(acc, limits) : truncateTail(acc, limits);
  if (!snap.truncated) return { truncated: false, body: snap.content || emptyText };

  const total = snap.totalLines;
  let body: string;
  if (truncation.mode === "head") {
    body = snap.content + `\n\n[L1-${snap.outputLines}/${total}`;
    if (snap.firstLineExceedsLimit) body += ` (first line > ${fmtSize(maxBytes)})`;
    else if (snap.truncatedBy === "bytes") body += ` (${fmtSize(maxBytes)} cap)`;
  } else {
    const start = total - snap.outputLines + 1;
    body = snap.content + `\n\n[L${start}-${total}/${total}`;
    if (snap.lastLinePartial) {
      const lastNl = acc.lastIndexOf("\n");
      const tailLine = lastNl === -1 ? acc : acc.slice(lastNl + 1);
      body += ` (${fmtSize(snap.outputBytes)} tail, L=${fmtSize(Buffer.byteLength(tailLine, "utf-8"))})`;
    } else if (snap.truncatedBy === "bytes") {
      body += ` (${fmtSize(maxBytes)} cap)`;
    }
  }
  return { truncated: true, body };
}
