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

export const probeModels = [
  probeModel("probe-test", 10),
  {
    ...probeModel("cheap", 0.2),
    compat: { supportsMidConvoSystemMessages: true },
  },
  {
    ...probeModel("equal", 1),
    compat: {
      supportsMidConvoSystemMessages: true,
      supportsDeveloperRole: false,
    },
  },
  probeModel("expensive", 2),
  probeModel("unknown", 0),
  probeModel("small", 0.2, 2048),
  probeModel("tiered", 0.2, 128000, [
    {
      inputTokensAbove: 1000,
      input: 2,
      output: 1,
      cacheRead: 0.1,
      cacheWrite: 1,
    },
  ]),
];

const rule = (to: string, from = "probe-test") => ({ from, to });
export const probeSubstitutionCases: [string, unknown, string, string?][] = [
  ["cheap", [rule("cheap:medium")], "cheap"],
  ["equal cache price", [rule("equal:medium")], "equal"],
  ["expensive", [rule("expensive:medium")], "probe-test"],
  ["unknown price", [rule("unknown:medium")], "probe-test"],
  ["smaller context", [rule("small:medium")], "probe-test"],
  ["expensive tier", [rule("tiered:medium")], "probe-test"],
  ["foreign provider", [rule("foreign-only:medium")], "probe-test"],
  ["no fuzzy lookup", [rule("che:medium")], "probe-test"],
  ["unmatched", [rule("cheap:medium", "other")], "probe-test"],
  ["disabled", [], "probe-test"],
  ["identity", [rule("probe-test:high")], "probe-test"],
  ["invalid", [{ from: 7, to: "cheap:medium" }], "probe-test"],
  [
    "bounded",
    Array.from({ length: 33 }, () => rule("cheap:medium")),
    "probe-test",
  ],
  ["fallthrough", [rule("expensive:medium"), rule("cheap:medium")], "cheap"],
  [
    "explicit model",
    [rule("cheap:medium")],
    "probe-test",
    "local/probe-test:high",
  ],
];
