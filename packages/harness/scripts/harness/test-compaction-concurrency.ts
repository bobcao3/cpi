import "@cpi/cli/bootstrap";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  current,
  control,
  local,
  open,
  close,
  check,
  firstUser,
  lastUser,
} from "./compaction-concurrency-fixture.ts";
import { sendCostReport } from "../../src/cost-tree/socket.ts";
import {
  CHECKPOINT_TYPE,
  type ContextCheckpoint,
} from "../../src/lib/compaction-checkpoint.ts";
import { setCwd } from "../../src/lib/cwd.ts";
const changed = /source history was replaced or edited/;
const budget = /insufficient room/;
async function settle(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate() && !current().session.isStreaming) return;
    await delay(20);
  }
  throw new Error("Concurrent producer did not settle within two seconds");
}
try {
  await check("cost socket reports", async () => {
    for (let i = 1; i <= 3; i++)
      assert(
        await sendCostReport(process.env.CPI_COST_SOCKET!, {
          version: 1,
          accounts: [
            {
              id: "run:concurrent-child",
              input: i * 100,
              output: i * 10,
              cost: i * 0.001,
              count: 1,
            },
          ],
        }),
      );
  });
  await check("alarm firing and notification", async () => {
    const runner = current().session.extensionRunner!;
    await runner
      .getToolDefinition("alarm")!
      .execute(
        "concurrent-alarm",
        { relative_seconds: 1, message: "CONCURRENT_ALARM" },
        undefined,
        undefined,
        runner.createToolContext("concurrent-alarm", undefined),
      );
    await settle(() =>
      current()
        .manager.getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "notification" &&
            JSON.stringify(entry.details).includes("CONCURRENT_ALARM"),
        ),
    );
  });
  await check("background shell completion and notification", async () => {
    const runner = current().session.extensionRunner!;
    const result = await runner.getToolDefinition("sh")!.execute(
      "concurrent-shell",
      {
        command: "sleep 0.2",
        waitfor: 0.01,
        description: "CONCURRENT_SHELL",
      },
      undefined,
      undefined,
      runner.createToolContext("concurrent-shell", undefined),
    );
    assert(!result.isError);
    await settle(() =>
      current()
        .manager.getBranch()
        .some(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "notification" &&
            JSON.stringify(entry.details).includes("CONCURRENT_SHELL"),
        ),
    );
  });
  await check("state and runtime refresh", () => {
    current().pi.appendEntry("cpi.status-report", {
      version: 1,
      report: "Working",
      turnCount: 0,
    });
    current().pi.appendEntry("goal-state", {
      objective: "LATEST_GOAL",
      active: true,
      paused: false,
      turnCount: 3,
    });
    writeFileSync(
      join(current().manager.getCwd(), "AGENTS.md"),
      "LATEST_PROJECT_INSTRUCTION",
    );
  });
  await check("appended messages", () => {
    current().manager.appendMessage({
      role: "user",
      content: "LATEST_USER_INSTRUCTION",
      timestamp: Date.now(),
    });
    current().manager.appendCustomMessageEntry(
      "notification",
      "LATEST_NOTIFICATION",
      true,
    );
  });
  await check("retained context edit", () =>
    current().manager.appendContextEdit(lastUser(), {
      content: "UPDATED_RETAINED_USER",
    }),
  );
  await check("new tail context edit", () => {
    const id = current().manager.appendMessage({
      role: "user",
      content: "BEFORE_TAIL_EDIT",
      timestamp: Date.now(),
    });
    current().manager.appendContextEdit(id, { content: "AFTER_TAIL_EDIT" });
  });
  await check("rewind", () => current().manager.branch(firstUser()), changed);
  await check(
    "divergent branch",
    () => {
      current().manager.branch(firstUser());
      current().manager.appendCustomEntry("cpi.status-report", { version: 1 });
    },
    changed,
  );
  await check(
    "source edit",
    () =>
      current().manager.appendContextEdit(firstUser(), {
        content: "CHANGED_SOURCE",
      }),
    changed,
  );
  await check(
    "source omission",
    () => current().manager.appendContextEdit(firstUser(), null),
    changed,
  );
  await check(
    "session replacement",
    () => current().manager.newSession(),
    changed,
  );
  await check(
    "competing checkpoint",
    () => current().manager.appendCompaction("OTHER_SUMMARY", lastUser(), 1000),
    changed,
  );
  await check(
    "tail budget growth",
    () =>
      current().manager.appendMessage({
        role: "user",
        content: "x".repeat(150_000),
        timestamp: Date.now(),
      }),
    budget,
  );
  await check(
    "retained edit budget growth",
    () =>
      current().manager.appendContextEdit(lastUser(), {
        content: "x".repeat(150_000),
      }),
    budget,
  );
  await check(
    "reference budget growth",
    () =>
      writeFileSync(
        join(current().manager.getCwd(), "AGENTS.md"),
        "x".repeat(100_000),
      ),
    budget,
  );
  await check(
    "abort retains context",
    () => current().session.abortCompaction(),
    /abort/i,
  );

  await open();
  try {
    const original = current().manager.getBranch();
    const boundary = original.at(-1)!.id;
    const oldNotice = current().manager.appendCustomMessageEntry(
      "notification",
      "OLD_NOTIFICATION",
      true,
    );
    control.during_summary = async () => {
      current().manager.appendCustomMessageEntry(
        "notification",
        "NEW_NOTIFICATION",
        true,
      );
      current().manager.appendMessage({
        role: "user",
        content: "NEW_USER_INSTRUCTION",
        timestamp: Date.now(),
      });
      current().manager.appendContextEdit(lastUser(), {
        content: "EDITED_NEW_USER_INSTRUCTION",
      });
      writeFileSync(
        join(current().manager.getCwd(), "AGENTS.md"),
        "REFRESHED_PROJECT_INSTRUCTION",
      );
    };
    await current().session.compact();
    const messages = await current().session.extensionRunner!.emitContext(
      current().manager.buildSessionProjection().messages,
    );
    const serialized = JSON.stringify(messages);
    const restored = messages.findIndex(
      (message) =>
        message.role === "custom" && message.customType === CHECKPOINT_TYPE,
    );
    const next = messages.findIndex(
      (message) =>
        message.role === "custom" && message.content === "NEW_NOTIFICATION",
    );
    assert(restored >= 0 && next > restored);
    assert(serialized.includes("EDITED_NEW_USER_INSTRUCTION"));
    assert(!serialized.includes("BEFORE_TAIL_EDIT"));
    assert(serialized.includes("REFRESHED_PROJECT_INSTRUCTION"));
    const notice = (content: string) =>
      messages.find(
        (message) => message.role === "custom" && message.content === content,
      )!;
    assert(
      current().noticeHidden(
        notice("OLD_NOTIFICATION") as Parameters<
          ReturnType<typeof current>["noticeHidden"]
        >[0],
      ),
    );
    assert.equal(
      current().noticeHidden(
        notice("NEW_NOTIFICATION") as Parameters<
          ReturnType<typeof current>["noticeHidden"]
        >[0],
      ),
      undefined,
    );
    const entry = current()
      .manager.getBranch()
      .slice()
      .reverse()
      .find((entry) => entry.type === "compaction")!;
    assert(entry.type === "compaction");
    assert.equal(
      (entry.details as { cpiContext: ContextCheckpoint }).cpiContext
        .boundaryId,
      oldNotice,
    );
    assert.notEqual(boundary, oldNotice);
    await current().session.reload();
    assert.deepEqual(
      await current().session.extensionRunner!.emitContext(
        current().manager.buildSessionProjection().messages,
      ),
      messages,
    );
    await current().session.prompt("Continue with the new instruction.");
    const payload = JSON.stringify(local.requests.at(-1).messages);
    assert(
      payload.indexOf("context-restored") < payload.indexOf("NEW_NOTIFICATION"),
    );
    assert(payload.includes("EDITED_NEW_USER_INSTRUCTION"));
    console.log(
      "compaction concurrency: durable checkpoint ordering, notification visibility, reload and provider continuation passed",
    );
  } finally {
    await close();
  }

  await open();
  try {
    control.during_summary = async () => {
      assert(
        await sendCostReport(process.env.CPI_COST_SOCKET!, {
          version: 1,
          accounts: [
            {
              id: "run:auto-child",
              input: 100,
              output: 10,
              cost: 0.01,
              count: 1,
            },
          ],
        }),
      );
    };
    control.request_tokens = 25000;
    current().settings.setCompactionEnabled(true);
    const before = control.summaries;
    await current().session.prompt("Trigger automatic compaction.");
    assert.equal(control.summaries, before + 1);
    assert(
      current()
        .manager.getBranch()
        .some((entry) => entry.type === "compaction"),
    );
    control.request_tokens = 256;
    await current().session.prompt("Continue after automatic compaction.");
    assert(
      JSON.stringify(local.requests.at(-1).messages).includes(
        "context-restored",
      ),
    );
    console.log(
      "compaction concurrency: automatic compaction and continuation passed",
    );
  } finally {
    control.request_tokens = 256;
    await close();
  }
} finally {
  setCwd(process.cwd());
  await local.close();
}
process.exit(0);
