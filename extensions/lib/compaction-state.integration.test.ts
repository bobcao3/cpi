// @ts-expect-error Bun test types are runtime-provided.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beginActivity, finishActivity, updateActivity } from "./activity.ts";
import { collectRuntimeState } from "./compaction-state.ts";
import { getCwd, setCwd } from "./cwd.ts";
import { setGoal } from "./goal.ts";

const codingEntry = fileURLToPath(
  import.meta.resolve("@earendil-works/pi-coding-agent"),
);
const { createAgentSession, DefaultResourceLoader, SessionManager } =
  (await await import(codingEntry)) as any;

const ext = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url));

const dir = mkdtempSync(join(tmpdir(), "cpi-compaction-"));
const agentDir = join(dir, "agent");
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(dir, "probe.env"), "PROBE_TOKEN=1\n");
writeFileSync(join(dir, "err.env"), "ERR_TOKEN=1\n");

let goalPi: any;
const loader = new DefaultResourceLoader({
  cwd: dir,
  agentDir,
  additionalExtensionPaths: [
    ext("../shell.ts"),
    ext("../cwd.ts"),
    ext("../alarm.ts"),
  ],
  extensionFactories: [
    {
      name: "goal-probe",
      factory: (pi: any) => {
        goalPi = pi;
      },
    },
  ],
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();
const { session } = await createAgentSession({
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(dir),
  cwd: dir,
  agentDir,
  noTools: "builtin",
});
await session.bindExtensions({});

const ctx = session.extensionRunner.createContext();
const tool = (name: string) => session.extensionRunner.getToolDefinition(name)!;
const sessionId = ctx.sessionManager.getSessionId();

const tracked = {
  shells: [] as string[],
  repeats: [] as string[],
  alarms: [] as string[],
  subagents: [] as string[],
};

async function cleanup(): Promise<void> {
  const signal = tool("sh_signal");
  for (const id of [...tracked.shells, ...tracked.repeats])
    await signal
      .execute("cleanup", { id, signal: "SIGKILL" }, undefined, undefined, ctx)
      .catch(() => {});
  const alarm = tool("alarm");
  for (const id of tracked.alarms)
    await alarm
      .execute("cleanup", { cancel: id }, undefined, undefined, ctx)
      .catch(() => {});
  for (const id of tracked.subagents) finishActivity(id, "cancelled");
  tracked.shells = [];
  tracked.repeats = [];
  tracked.alarms = [];
  tracked.subagents = [];
}

function pendingAlarmIdsFromBranch(): string[] {
  const ids: string[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "custom" || entry.customType !== "alarm-state") continue;
    for (const a of ((entry.data as any)?.alarms ?? []) as any[])
      if (a?.fired !== true && typeof a?.id === "string") ids.push(a.id);
  }
  return ids;
}

afterAll(async () => {
  tracked.alarms.push(...pendingAlarmIdsFromBranch());
  await cleanup().catch(() => {});
  try {
    session.dispose();
  } catch {}
  setCwd(process.cwd());
  rmSync(dir, { recursive: true, force: true });
});

function appendToolPair(
  toolName: string,
  args: Record<string, unknown>,
  isError: boolean,
): void {
  const callId = `call_${toolName}_${Math.random().toString(36).slice(2, 8)}`;
  session.sessionManager.appendMessage({
    role: "assistant",
    content: [
      { type: "toolCall", id: callId, name: toolName, arguments: args },
    ],
    api: "openai-completions",
    provider: "probe",
    model: "probe-model",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as any);
  session.sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: callId,
    toolName,
    content: [{ type: "text", text: "ok" }],
    isError,
    timestamp: Date.now(),
  } as any);
}

async function settleLiveEmpty(kind: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (collectRuntimeState(ctx)[kind].length === 0) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${kind} did not drain`);
}

test("snapshot is empty on a fresh real session", () => {
  expect(collectRuntimeState(ctx)).toEqual({
    cwd: getCwd(),
    model: { provider: "unknown", modelId: "unknown" },
    alarms: [],
    shells: [],
    repeats: [],
    subagents: [],
    environments: [],
  });
});

test("collects goal, alarms, shells, repeats, subagents and env refs", async () => {
  const alarm = tool("alarm");
  const sh = tool("sh");
  const repeat = tool("sh_repeat_until");
  try {
    setGoal(goalPi, "probe objective");
    await tool("set_cwd").execute(
      "t4",
      { path: dir },
      undefined,
      undefined,
      ctx,
    );
    await alarm.execute(
      "t1",
      { relative_seconds: 3600, message: "probe alarm" },
      undefined,
      undefined,
      ctx,
    );
    const bg = await sh.execute(
      "t2",
      { command: "sleep 30", description: "probe bg", waitfor: 1 },
      undefined,
      undefined,
      ctx,
    );
    tracked.shells.push(String((bg as any).details.id));
    const rpt = await repeat.execute(
      "t3",
      {
        command: "true",
        interval: 5,
        description: "probe repeat",
        env: "probe.env",
      },
      undefined,
      undefined,
      ctx,
    );
    tracked.repeats.push((rpt as any).details.id);
    appendToolPair(
      "sh_repeat_until",
      {
        command: "true",
        interval: 5,
        description: "probe repeat",
        env: "probe.env",
      },
      false,
    );
    await sh.execute(
      "t5",
      { command: "true", description: "env probe", env: "probe.env" },
      undefined,
      undefined,
      ctx,
    );
    appendToolPair(
      "sh",
      { command: "true", description: "env probe", env: "probe.env" },
      false,
    );
    await sh.execute(
      "t5b",
      { command: "exit 3", description: "err probe", env: "err.env" },
      undefined,
      undefined,
      ctx,
    );
    appendToolPair(
      "sh",
      { command: "exit 3", description: "err probe", env: "err.env" },
      true,
    );
    beginActivity({
      id: "probe-subagent",
      kind: "subagent",
      status: "running",
      session_id: sessionId,
      label: "tester: probe subagent",
      cwd: dir,
      started_at: Date.now(),
      metrics: { worker_thread: 1, usage_scope: "self", role: "tester" },
    });
    tracked.subagents.push("probe-subagent");
    updateActivity("probe-subagent", {
      log_path: join(dir, "child.md"),
      metrics: {
        child_session_id: "probe-child-session",
        session_file: join(dir, "child.jsonl"),
        model: "probe/provider",
        effort: "off",
        markdown_path: join(dir, "child.md"),
        diagnostics_path: join(dir, "child.diagnostics"),
      },
    });

    const snap = collectRuntimeState(ctx);
    expect(snap.cwd).toBe(dir);
    expect(snap.goal).toMatchObject({
      objective: "probe objective",
      active: true,
      paused: false,
    });
    expect(snap.goal!.startedAtMs).toBeGreaterThan(0);
    expect(snap.alarms).toHaveLength(1);
    expect(snap.alarms[0]).toMatchObject({ id: "a1", message: "probe alarm" });
    expect(snap.alarms[0].targetMs).toBeGreaterThan(Date.now());
    tracked.alarms.push(snap.alarms[0].id);
    expect(snap.shells).toHaveLength(1);
    expect(snap.shells[0].id).toBe(String((bg as any).details.id));
    expect(snap.shells[0].status).toBe("running");
    expect(snap.repeats).toHaveLength(1);
    expect(snap.repeats[0].id).toBe((rpt as any).details.id);
    expect(snap.repeats[0].intervalSec).toBe(5);
    expect(snap.subagents).toEqual([
      {
        id: "probe-subagent",
        sessionId: "probe-child-session",
        sessionFile: join(dir, "child.jsonl"),
        logPath: join(dir, "child.md"),
        status: "running",
        startedAt: expect.any(Number),
        label: "tester: probe subagent",
        model: "probe/provider",
        role: "tester",
      },
    ]);
    expect(snap.environments).toEqual([
      { path: join(dir, "probe.env"), tools: ["sh", "sh_repeat_until"] },
    ]);

    await cleanup();
    await settleLiveEmpty("shells");
    await settleLiveEmpty("repeats");
    const after = collectRuntimeState(ctx);
    expect(after.alarms).toEqual([]);
    expect(after.shells).toEqual([]);
    expect(after.repeats).toEqual([]);
    expect(after.subagents).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("throws when environment references exceed the limit", () => {
  for (let i = 0; i < 65; i++) {
    appendToolPair(
      "sh",
      { command: "true", description: "overflow", env: `e${i}.env` },
      false,
    );
  }
  expect(() => collectRuntimeState(ctx)).toThrow(
    /environment references exceed/,
  );
});

test("throws when pending alarms exceed the limit", () => {
  session.sessionManager.appendCustomEntry("alarm-state", {
    alarms: Array.from({ length: 65 }, (_, i) => ({
      id: `x${i}`,
      targetMs: Date.now() + 60000,
      fired: false,
    })),
  });
  expect(() => collectRuntimeState(ctx)).toThrow(/pending alarms .* exceed/);
});
