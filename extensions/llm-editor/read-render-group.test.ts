import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { getThemeByName } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { readTool } from "./tool.ts";
import {
  recordReadCalls,
  recordReadResult,
  resetReadBatches,
} from "./read-render.ts";

const theme = getThemeByName("dark")!;
const indent = " ".repeat(visibleWidth("⏳ Reading "));
const visible = (component: { render(width: number): string[] }) =>
  component.render(80).map(stripVTControlCharacters).join("\n").trimEnd();

test("concurrent reads group adjacent statuses without moving completed events", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-group-"));
  const paths = ["A.py", "B.py", "C.py"].map((name) => join(dir, name));
  resetReadBatches([]);
  try {
    for (const path of paths) await writeFile(path, "one\ntwo\n");
    const calls = paths.map((path, index) => ({
      id: `group-${index}`,
      name: "read",
      arguments: { path, ...(index === 2 ? { query: "locate function" } : {}) },
    }));
    recordReadCalls(calls);
    let updates = 0;
    const context = (index: number, isPartial: boolean) =>
      ({
        toolCallId: calls[index].id,
        args: calls[index].arguments,
        cwd: dir,
        isPartial,
        isError: false,
        invalidate: () => {
          updates++;
        },
      }) as any;
    const lead = readTool.renderCall(
      calls[0].arguments,
      theme,
      context(0, true),
    );
    assert.equal(
      visible(lead),
      `⏳ Reading A.py\n${indent}B.py\n${indent}C.py for locate function`,
    );
    assert.equal(
      visible(readTool.renderCall(calls[1].arguments, theme, context(1, true))),
      "",
    );

    const second = await readTool.execute(
      "group-1",
      { path: paths[1] },
      undefined,
      undefined,
      { cwd: dir } as any,
    );
    recordReadResult(calls[1].id, second, false);
    assert.equal(
      visible(lead),
      `⏳ Reading A.py\n${indent}C.py for locate function\n✓ Read B.py:2 lines`,
    );
    const viewed = {
      content: [{ type: "text", text: "1|one\n2|two" }],
      details: {
        kind: "view",
        ranges: [[1, 2]],
        summary: "Contains two lines",
      },
    };
    recordReadResult(calls[2].id, viewed, false);
    assert.equal(
      visible(lead),
      "⏳ Reading A.py\n✓ Read B.py:2 lines\n       C.py:L1-2 Contains two lines",
    );

    const first = await readTool.execute(
      "group-0",
      { path: paths[0] },
      undefined,
      undefined,
      { cwd: dir } as any,
    );
    recordReadResult(calls[0].id, first, false);
    const finished = readTool.renderResult(
      first,
      { isPartial: false, expanded: false },
      theme,
      context(0, false),
    );
    assert.equal(
      visible(finished),
      "✓ Read B.py:2 lines\n       C.py:L1-2 Contains two lines\n✓ Read A.py:2 lines",
    );
    recordReadResult(calls[1].id, second, false);
    assert.equal(
      visible(finished),
      "✓ Read B.py:2 lines\n       C.py:L1-2 Contains two lines\n✓ Read A.py:2 lines",
    );
    assert.equal(
      visible(
        readTool.renderResult(
          second,
          { isPartial: false, expanded: false },
          theme,
          context(1, false),
        ),
      ),
      "",
    );
    assert.equal(updates, 3);
  } finally {
    resetReadBatches([]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("read groups rebuild from a real session branch without mixing batches", () => {
  const session = SessionManager.inMemory();
  const assistant = (prefix: string) => ({
    role: "assistant",
    content: ["first", "second"].map((name) => ({
      type: "toolCall",
      id: `${prefix}-${name}`,
      name: "read",
      arguments: { path: `${name}.ts` },
    })),
    api: "openai-completions",
    provider: "probe",
    model: "probe-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  });
  const result = (id: string, count: number) => ({
    role: "toolResult",
    toolCallId: id,
    toolName: "read",
    content: [{ type: "text", text: "contents" }],
    details: { kind: "content", lineCount: count },
    isError: false,
    timestamp: Date.now(),
  });
  session.appendMessage(assistant("old") as any);
  session.appendMessage(result("old-second", 12) as any);
  session.appendMessage(result("old-first", 3) as any);
  session.appendMessage(assistant("new") as any);
  session.appendMessage(result("new-first", 5) as any);
  resetReadBatches(session.getBranch());
  try {
    const call = (id: string) =>
      visible(
        readTool.renderCall({ path: "first.ts" }, theme, {
          toolCallId: id,
          isPartial: true,
        } as any),
      );
    assert.equal(
      call("old-first"),
      "✓ Read second.ts:12 lines, first.ts:3 lines",
    );
    assert.equal(
      call("new-first"),
      "⏳ Reading second.ts\n✓ Read first.ts:5 lines",
    );
    resetReadBatches([]);
    assert.equal(call("old-first"), "⏳ Reading first.ts");
  } finally {
    resetReadBatches([]);
  }
});

test("unqueried concurrent reads share one pending line", () => {
  resetReadBatches([]);
  try {
    recordReadCalls([
      { id: "plain-a", name: "read", arguments: { path: "A.py" } },
      { id: "plain-b", name: "read", arguments: { path: "B.py" } },
    ]);
    assert.equal(
      visible(
        readTool.renderCall({ path: "A.py" }, theme, {
          toolCallId: "plain-a",
          isPartial: true,
        } as any),
      ),
      "⏳ Reading A.py, B.py",
    );
  } finally {
    resetReadBatches([]);
  }
});

test("directory reads use their own result group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "read-dirs-"));
  resetReadBatches([]);
  try {
    const paths = ["note.txt", "alpha", "beta"].map((name) => join(dir, name));
    await writeFile(paths[0], "one\n");
    await mkdir(paths[1]);
    await mkdir(paths[2]);
    const calls = paths.map((path, index) => ({
      id: `dir-${index}`,
      name: "read",
      arguments: { path },
    }));
    const result = await Promise.all(
      paths.map((path, index) =>
        readTool.execute(calls[index].id, { path }, undefined, undefined, {
          cwd: dir,
        } as any),
      ),
    );
    assert.equal(
      visible(
        readTool.renderResult(
          result[1],
          { isPartial: false, expanded: false },
          theme,
          { args: { path: paths[1] }, isError: false } as any,
        ),
      ),
      "✓ Listed dir: alpha",
    );
    recordReadCalls(calls);
    for (const index of [0, 1, 2])
      recordReadResult(calls[index].id, result[index], false);
    assert.equal(
      visible(
        readTool.renderResult(
          result[0],
          { isPartial: false, expanded: false },
          theme,
          {
            args: calls[0].arguments,
            toolCallId: calls[0].id,
            isError: false,
          } as any,
        ),
      ),
      "✓ Read note.txt:1 lines\n✓ Listed dir: alpha, beta",
    );
    assert.equal(
      visible(
        readTool.renderResult(
          result[2],
          { isPartial: false, expanded: false },
          theme,
          {
            args: calls[2].arguments,
            toolCallId: calls[2].id,
            isError: false,
          } as any,
        ),
      ),
      "",
    );
  } finally {
    resetReadBatches([]);
    await rm(dir, { recursive: true, force: true });
  }
});
