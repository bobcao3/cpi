import type { ProviderResult, SearchProvider } from "./types.ts";

export type ProviderAttempt = {
  provider: SearchProvider["name"];
  error: string;
};

export type RoutedResult = ProviderResult & {
  provider: SearchProvider["name"];
  truncated: boolean;
  attempts: ProviderAttempt[];
};

export interface ProviderFactory {
  name: SearchProvider["name"];
  create(
    signal: AbortSignal,
  ): Promise<SearchProvider | undefined> | SearchProvider;
}

function failure_message(error: unknown, signal: AbortSignal): string {
  if (signal.aborted) return "Provider timed out";
  const message = error instanceof Error ? error.message : "";
  const status = message.match(/\bHTTP [1-5]\d{2}\b/)?.[0];
  return status ?? "Provider failed or returned no usable content";
}

export async function route(
  providers: ProviderFactory[],
  execute: (
    provider: SearchProvider,
    signal: AbortSignal,
  ) => Promise<ProviderResult>,
  timeoutMs: number,
  maxCharacters: number,
  signal?: AbortSignal,
): Promise<RoutedResult> {
  const attempts: ProviderAttempt[] = [];
  for (const factory of providers) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Provider timed out")),
      timeoutMs,
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let reject_abort: () => void;
    const cancellation = new Promise<never>((_, reject) => {
      reject_abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", reject_abort, { once: true });
    });
    try {
      const result = await Promise.race([
        (async () => {
          const provider = await factory.create(controller.signal);
          controller.signal.throwIfAborted();
          if (!provider) return undefined;
          const response = await execute(provider, controller.signal);
          if (!response.text?.trim()) throw new Error("Empty provider content");
          return response;
        })(),
        cancellation,
      ]);
      if (!result) continue;
      const text = result.text.slice(0, maxCharacters);
      return {
        provider: factory.name,
        text,
        sources: result.sources.slice(0, 100),
        truncated:
          Boolean(result.truncated) || text.length < result.text.length,
        ...(result.usage ? { usage: result.usage } : {}),
        attempts,
      };
    } catch (error) {
      signal?.throwIfAborted();
      attempts.push({
        provider: factory.name,
        error: failure_message(error, controller.signal),
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      controller.signal.removeEventListener("abort", reject_abort!);
    }
  }
  if (!attempts.length)
    throw new Error(
      "No configured search provider is available. Check provider credentials and endpoints.",
    );
  throw new Error(
    `All search providers failed: ${attempts.map((attempt) => `${attempt.provider}: ${attempt.error}`).join("; ")}`,
  );
}
