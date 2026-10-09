import { MAX_DIFF_TOTAL_BYTES } from "./udiff.ts";
export const MAX_DIRECT_OUTPUT_BYTES = MAX_DIFF_TOTAL_BYTES + 1024;
export const DIRECT_EDIT_CANCELED = "*** EDIT CANCELED ***";

export type DirectDiffMarkers = "angle" | "patch";

export function directDiffEnvelope(markers: DirectDiffMarkers): {
  open: string;
  close: string;
} {
  if (markers === "patch")
    return { open: "*** Begin Patch", close: "*** End Patch" };
  return { open: "<<<<<<< DIFF", close: ">>>>>>> DIFF" };
}

export type DirectDiffError =
  | "too_large"
  | "missing_envelope"
  | "multiple_envelopes"
  | "bad_envelope"
  | "outside_text"
  | "empty_diff";

export type DirectDiffResult =
  | { ok: true; diff: string }
  | { ok: true; cancel: true }
  | { ok: false; error: DirectDiffError };

export function parseDirectDiff(
  raw: string,
  markers: DirectDiffMarkers = "patch",
): DirectDiffResult {
  if (Buffer.byteLength(raw, "utf8") > MAX_DIRECT_OUTPUT_BYTES)
    return { ok: false, error: "too_large" };
  if (raw.trim() === DIRECT_EDIT_CANCELED) return { ok: true, cancel: true };

  const { open, close } = directDiffEnvelope(markers);
  const lines = raw.split("\n");
  const opens: number[] = [];
  const closes: number[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].endsWith("\r")
      ? lines[index].slice(0, -1)
      : lines[index];
    if (line === open) opens.push(index);
    if (line === close) closes.push(index);
  }

  if (opens.length === 0 || closes.length === 0)
    return { ok: false, error: "missing_envelope" };
  if (opens.length !== 1 || closes.length !== 1)
    return { ok: false, error: "multiple_envelopes" };
  if (opens[0] >= closes[0]) return { ok: false, error: "bad_envelope" };
  if (
    lines.slice(0, opens[0]).some((line) => line.trim() !== "") ||
    lines.slice(closes[0] + 1).some((line) => line.trim() !== "")
  )
    return { ok: false, error: "outside_text" };

  const diff = lines.slice(opens[0] + 1, closes[0]).join("\n");
  if (Buffer.byteLength(diff, "utf8") > MAX_DIFF_TOTAL_BYTES)
    return { ok: false, error: "too_large" };
  if (diff.trim() === "") return { ok: false, error: "empty_diff" };
  return { ok: true, diff };
}
