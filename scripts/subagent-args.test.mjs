import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBAGENT_USAGE,
  parseSubagentArgs,
} from "../bin/subagent-args.mjs";

const expected = {
  provider: "openai-codex",
  providerExplicit: true,
  model: "gpt-5.6-sol:medium",
  sessionId: "review",
  task: ["inspect", "this"],
};

test("short and long subagent options parse identically", () => {
  assert.deepEqual(
    parseSubagentArgs([
      "-p",
      "openai-codex",
      "-m",
      "gpt-5.6-sol:medium",
      "-s",
      "review",
      "inspect",
      "this",
    ]),
    expected,
  );
  assert.deepEqual(
    parseSubagentArgs([
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-sol:medium",
      "--session-id",
      "review",
      "inspect",
      "this",
    ]),
    expected,
  );
});

test("double dash terminates subagent option parsing", () => {
  assert.deepEqual(parseSubagentArgs(["--", "-m", "literal"]), {
    provider: "",
    providerExplicit: false,
    model: "",
    sessionId: "",
    task: ["-m", "literal"],
  });
});

test("unknown and valueless options return usage", () => {
  for (const argv of [["--unknown"], ["--provider"]]) {
    assert.throws(() => parseSubagentArgs(argv), {
      message: SUBAGENT_USAGE,
    });
  }
});
