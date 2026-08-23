// @ts-expect-error Bun test types are runtime-provided and not a package dependency.
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  validCliSubagentRequest,
  validForkProbeSubagentRequest,
  validLlmEditorCandidate,
  validLlmEditorCorrectionPrompt,
  validLlmEditorSubagentRequest,
  validSubagentWorkerRequest,
} from "./subagent-rpc-protocol.ts";

const common = {
  version: 1 as const,
  cwd: process.cwd(),
  env: { PATH: process.env.PATH ?? "" },
  runId: "rpc-test",
};

const editor = {
  ...common,
  version: 2 as const,
  kind: "llm-editor" as const,
  role: "editor" as const,
  systemPrompt: "edit",
  task: "1|old",
  provider: "provider",
  modelId: "model",
  outputMode: "text" as const,
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
};

describe("subagent RPC request boundary", () => {
  test("keeps the external CLI shape separate from trusted editor requests", () => {
    const cli = { ...common, argv: [], task: "answer" };
    expect(validCliSubagentRequest(cli)).toBe(true);
    expect(validCliSubagentRequest({ ...cli, kind: "llm-editor" })).toBe(false);
    expect(validLlmEditorSubagentRequest(editor)).toBe(true);
    expect(validLlmEditorSubagentRequest({ ...editor, version: 1 })).toBe(
      false,
    );
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

  test("requires a bounded absolute completion path only in tool-call mode", () => {
    expect(
      validLlmEditorSubagentRequest({
        ...editor,
        outputMode: "tool-call",
        completionPath: resolve("completion.json"),
      }),
    ).toBe(true);
    expect(
      validLlmEditorSubagentRequest({
        ...editor,
        outputMode: "tool-call",
      }),
    ).toBe(false);
    expect(
      validLlmEditorSubagentRequest({
        ...editor,
        completionPath: resolve("completion.json"),
      }),
    ).toBe(false);
  });

  test("allows numbered editor input beyond the smaller CLI task bound", () => {
    const expanded = "x".repeat(2 * 1024 * 1024);
    expect(validLlmEditorSubagentRequest({ ...editor, task: expanded })).toBe(
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
      validLlmEditorSubagentRequest({
        ...editor,
        task: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).toBe(false);
  });

  test("bounds continuation turns and output bytes", () => {
    expect(validLlmEditorSubagentRequest({ ...editor, maxTurns: 9 })).toBe(
      true,
    );
    expect(validLlmEditorSubagentRequest({ ...editor, maxTurns: 10 })).toBe(
      false,
    );
    expect(
      validLlmEditorSubagentRequest({ ...editor, maxOutputBytes: 0 }),
    ).toBe(false);
  });

  test("validates candidate and correction feedback boundaries", () => {
    const candidate = {
      kind: "candidate",
      turn: 0,
      completion: null,
      text: "patch",
      outputOverflow: false,
    };
    expect(validLlmEditorCandidate(candidate, editor)).toBe(true);
    expect(validLlmEditorCandidate({ ...candidate, turn: 1 }, editor)).toBe(
      false,
    );
    expect(validLlmEditorCorrectionPrompt("x".repeat(65536))).toBe(true);
    expect(validLlmEditorCorrectionPrompt("x".repeat(65537))).toBe(false);
  });

  test("accepts only edit-complete tool candidates for editors", () => {
    const toolEditor = {
      ...editor,
      outputMode: "tool-call" as const,
      completionPath: resolve("completion.json"),
    };
    const candidate = {
      kind: "candidate",
      turn: 0,
      completion: { tool: "edit-complete", args: {} },
      text: "",
      outputOverflow: false,
    };
    expect(validLlmEditorCandidate(candidate, toolEditor)).toBe(true);
    expect(
      validLlmEditorCandidate(
        {
          ...candidate,
          completion: { tool: "view-complete", args: {} },
        },
        toolEditor,
      ),
    ).toBe(false);
  });

  test("bounds inherited environment entries", () => {
    const env = Object.fromEntries(
      Array.from({ length: 513 }, (_, index) => [`K${index}`, "v"]),
    );
    expect(validLlmEditorSubagentRequest({ ...editor, env })).toBe(false);
  });
});
