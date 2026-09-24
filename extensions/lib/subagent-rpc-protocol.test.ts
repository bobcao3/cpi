// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  validCliSubagentRequest,
  validForkProbeSubagentRequest,
  validSubagentCandidate,
  validSubagentContinuationPrompt,
  validSessionSubagentRequest,
  validSubagentWorkerRequest,
} from "./subagent-rpc-protocol.ts";

const common = {
  version: 1 as const,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  runId: "rpc-test",
};

const session = {
  ...common,
  version: 1 as const,
  kind: "session" as const,
  extensionPaths: [] as string[],
  systemPrompt: "edit",
  task: "1|old",
  provider: "provider",
  modelId: "model",
  maxTurns: 1,
  maxOutputBytes: 524288,
};

const forkProbe = {
  ...common,
  version: 1 as const,
  kind: "fork-probe" as const,
  parentSessionFile: resolve("parent.jsonl"),
  parentSessionId: "12345678-1234-1234-1234-123456789abc",
  sessionDir: resolve("fork-session"),
  prompt: "evaluate",
  toolsDisabledMessage: "Tools are disabled.",
  maxOutputTokens: 1024,
};

describe("subagent RPC request boundary", () => {
  test("keeps the external CLI shape separate from trusted session requests", () => {
    const cli = { ...common, argv: [], task: "answer" };
    expect(validCliSubagentRequest(cli)).toBe(true);
    expect(validCliSubagentRequest({ ...cli, kind: "session" })).toBe(false);
    expect(validSessionSubagentRequest(session)).toBe(true);
    expect(validSessionSubagentRequest({ ...session, version: 2 })).toBe(false);
  });

  test("accepts trusted bounded fork requests only on the Worker boundary", () => {
    expect(validForkProbeSubagentRequest(forkProbe)).toBe(true);
    expect(validSubagentWorkerRequest(forkProbe)).toBe(true);
    expect(validCliSubagentRequest(forkProbe)).toBe(false);
    expect(
      validForkProbeSubagentRequest({
        ...forkProbe,
        parentSessionFile: "relative.jsonl",
      }),
    ).toBe(false);
    expect(
      validForkProbeSubagentRequest({ ...forkProbe, parentSessionId: "bad-" }),
    ).toBe(false);
    expect(
      validForkProbeSubagentRequest({ ...forkProbe, toolsDisabledMessage: "" }),
    ).toBe(false);
    expect(
      validForkProbeSubagentRequest({ ...forkProbe, maxOutputTokens: 0 }),
    ).toBe(false);
    expect(
      validForkProbeSubagentRequest({
        ...forkProbe,
        parentSessionId: "x".repeat(129),
      }),
    ).toBe(false);
    expect(validForkProbeSubagentRequest({ ...forkProbe, prompt: "" })).toBe(
      false,
    );
    expect(
      validForkProbeSubagentRequest({
        ...forkProbe,
        prompt: "x".repeat(256 * 1024 + 1),
      }),
    ).toBe(false);
    expect(
      validForkProbeSubagentRequest({ ...forkProbe, env: { BROKEN: 1 } }),
    ).toBe(false);
  });

  test("allows numbered session input beyond the smaller CLI task bound", () => {
    const expanded = "x".repeat(2 * 1024 * 1024);
    expect(validSessionSubagentRequest({ ...session, task: expanded })).toBe(
      true,
    );
    expect(
      validCliSubagentRequest({
        ...common,
        argv: [],
        task: expanded,
      }),
    ).toBe(false);
    expect(
      validSessionSubagentRequest({
        ...session,
        task: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).toBe(false);
  });

  test("bounds continuation turns and output bytes", () => {
    expect(validSessionSubagentRequest({ ...session, maxTurns: 9 })).toBe(true);
    expect(validSessionSubagentRequest({ ...session, maxTurns: 10 })).toBe(
      false,
    );
    expect(validSessionSubagentRequest({ ...session, maxOutputBytes: 0 })).toBe(
      false,
    );
  });

  test("validates candidate and correction feedback boundaries", () => {
    const candidate = {
      kind: "candidate",
      turn: 0,
      text: "patch",
      outputOverflow: false,
    };
    expect(validSubagentCandidate(candidate, session)).toBe(true);
    expect(validSubagentCandidate({ ...candidate, turn: 1 }, session)).toBe(
      false,
    );
    expect(validSubagentContinuationPrompt("x".repeat(65536))).toBe(true);
    expect(validSubagentContinuationPrompt("x".repeat(65537))).toBe(false);
  });

  test("bounds extension paths and tool names as unique lists", () => {
    const paths = Array.from({ length: 16 }, (_, i) =>
      resolve(`extension-${i}.ts`),
    );
    expect(
      validSessionSubagentRequest({ ...session, extensionPaths: paths }),
    ).toBe(true);
    for (const extensionPaths of [
      undefined,
      "bad",
      [...paths, resolve("extra.ts")],
      [paths[0], paths[0]],
      ["relative.ts"],
      ["/bad\0"],
      ["/" + "é".repeat(2048)],
      [42],
    ]) {
      expect(validSessionSubagentRequest({ ...session, extensionPaths })).toBe(
        false,
      );
    }
    const names = Array.from({ length: 64 }, (_, i) => `tool-${i}`);
    expect(validSessionSubagentRequest({ ...session, tools: names })).toBe(
      true,
    );
    expect(validSessionSubagentRequest({ ...session, tools: [] })).toBe(true);
    expect(
      validSessionSubagentRequest({ ...session, tools: ["é".repeat(64)] }),
    ).toBe(true);
    for (const tools of [
      null,
      "read",
      [...names, "extra"],
      ["read", "read"],
      [""],
      ["bad\0"],
      ["é".repeat(65)],
      [42],
    ]) {
      expect(validSessionSubagentRequest({ ...session, tools })).toBe(false);
    }
  });

  test("validates cache retention and rejects unexpected candidate fields", () => {
    for (const cacheRetention of [undefined, "none", "short", "long"]) {
      expect(validSessionSubagentRequest({ ...session, cacheRetention })).toBe(
        true,
      );
    }
    for (const cacheRetention of [null, "forever", 1]) {
      expect(validSessionSubagentRequest({ ...session, cacheRetention })).toBe(
        false,
      );
    }
    expect(
      validSubagentCandidate(
        {
          kind: "candidate",
          turn: 0,
          text: "{}",
          outputOverflow: false,
          unexpected: true,
        },
        session,
      ),
    ).toBe(false);
  });

  test("bounds inherited environment entries", () => {
    const env = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`K${index}`, "v"]),
    );
    expect(validSessionSubagentRequest({ ...session, env })).toBe(false);
  });
});
