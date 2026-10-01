import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

const RESPONSE_LIMIT_BYTES = 64 * 1024;

export interface UsageSource<Report> {
  providers: readonly string[];
  /** Latest report, or undefined when the provider has no usable credential. */
  fetch(
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<Report | undefined>;
  /** Segment text for a report, or undefined to hide the segment. */
  format(report: Report, now: number, theme?: Theme): string | undefined;
  /** Instant the rendered text changes without a new report, e.g. a countdown tick. */
  nextChange?(report: Report, now: number): number | undefined;
}

export function sourceForProvider(
  sources: readonly UsageSource<unknown>[],
  provider: string | undefined,
): UsageSource<unknown> | undefined {
  if (!provider) return undefined;
  return sources.find((source) => source.providers.includes(provider));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Usage response has no body");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        throw new Error("Usage response exceeds size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
  return JSON.parse(body);
}

export async function fetchJson(
  url: string,
  token: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    },
    signal,
  });
  if (!response.ok)
    throw new Error(`Usage HTTP ${response.status} from ${url}`);
  return readJsonBounded(response);
}
