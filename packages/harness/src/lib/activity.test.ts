import { test, expect } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginActivity,
  updateActivity,
  finishActivity,
  listActivities,
  readActivityTail,
  type ActivityEntry,
} from "./activity.ts";

test("bounded snapshots, live ordering, history eviction and safe regular-file tails", async () => {
  const session_id = `registry-${Date.now()}`;
  const make = (id: string, started_at: number): ActivityEntry => ({
    id: `${session_id}-${id}`,
    kind: "shell",
    status: "running",
    session_id,
    label: id,
    started_at,
  });
  beginActivity(make("new", 2));
  beginActivity(make("old", 1));
  expect(listActivities(session_id).map((entry) => entry.label)).toEqual([
    "old",
    "new",
  ]);
  finishActivity(make("old", 1).id, "completed");
  expect(listActivities(session_id).map((entry) => entry.label)).toEqual([
    "new",
    "old",
  ]);
  updateActivity(make("new", 2).id, { metrics: { pid: 123 } });
  const snapshot = listActivities(session_id);
  snapshot[0].metrics!.pid = 999;
  expect(listActivities(session_id)[0].metrics!.pid).toBe(123);
  finishActivity(make("new", 2).id, "detached");
  finishActivity(make("new", 2).id, "completed");
  expect(
    listActivities(session_id).find((entry) => entry.label === "new")!.status,
  ).toBe("detached");
  for (let i = 0; i < 300; i++) {
    const entry = make(`history-${i}`, i);
    beginActivity(entry);
    finishActivity(entry.id, "completed");
    updateActivity(entry.id, { ended_at: 1000 + i });
  }
  expect(
    listActivities().filter(
      (entry) => !["running", "stopping"].includes(entry.status),
    ).length,
  ).toBeLessThanOrEqual(256);
  for (let i = 0; i < 300; i++) beginActivity(make(`active-${i}`, i));
  expect(
    listActivities().filter((entry) => entry.status === "running").length,
  ).toBeLessThanOrEqual(256);
  for (const entry of listActivities(session_id))
    finishActivity(entry.id, "cancelled");
  const directory = await mkdtemp(join(tmpdir(), "activity-tail-"));
  try {
    const path = join(directory, "output");
    await writeFile(
      path,
      "🦀".repeat(20000) +
        "\x1b[31mred\x1b[0m\x1b]52;c;secret\x07\x00\r\u202eevil\n",
    );
    const entry = { ...make("tail", 0), log_path: path };
    const tail = await readActivityTail(entry);
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(32768);
    expect(tail).toEndWith("redevil\n");
    expect(tail).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202e]/);
    expect(
      await readActivityTail({
        ...entry,
        log_path: directory,
        tail: "safe\x1b[31m fallback",
      }),
    ).toBe("safe fallback");
    expect(
      await readActivityTail({
        ...entry,
        log_path: join(directory, "missing"),
      }),
    ).toMatch(/unavailable/);
    expect(await readActivityTail({ ...entry, log_path: "/dev/null" })).toMatch(
      /unavailable/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
