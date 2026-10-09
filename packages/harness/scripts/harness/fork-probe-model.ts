export function probeModel(
  id: string,
  input: number,
  contextWindow = 128000,
  tiers?: {
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[],
) {
  return {
    id,
    name: id,
    reasoning: true,
    input: ["text"],
    contextWindow,
    maxTokens: 1024,
    cost: {
      input,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
      ...(tiers ? { tiers } : {}),
    },
  };
}
