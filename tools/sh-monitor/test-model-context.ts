import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const root = mkdtempSync(join(tmpdir(), "cpi-model-context-"));
const agentDir = join(root, "agent");
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_SUBAGENT = "1";
process.env.CPI_FORK_PROBE = "1";
const provider = "model-context-test";
const models = ["base", "base-fast", "mid-a", "mid-b"].map((id) => ({
  id,
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 4096,
  cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
}));
writeFileSync(
  join(agentDir, "models.json"),
  JSON.stringify({
    providers: {
      [provider]: {
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        models,
      },
    },
  }),
);
const runtime = await ModelRuntime.create({
  modelsPath: join(agentDir, "models.json"),
  authPath: join(agentDir, "auth.json"),
});
const base = runtime.getModel(provider, "base")!;
const fast = runtime.getModel(provider, "base-fast")!;
const mid_a = runtime.getModel(provider, "mid-a")!;
const mid_b = runtime.getModel(provider, "mid-b")!;
assert(base && fast && mid_a && mid_b);
const captures: any[] = [];
const errors: string[] = [];
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] =
  [];
let payload_ready: (() => void) | undefined;
let payload_release: Promise<void> | undefined;

async function open(manager: SessionManager, minimal = false) {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [
      resolve(
        minimal ? "extensions/lib/model-context.ts" : "extensions/core.ts",
      ),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: manager,
    modelRuntime: runtime,
    noTools: "all",
  });
  sessions.push(session);
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error.error),
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    stream(model, context, {
      ...options,
      onPayload: async (payload, model) => {
        const transformed = await options?.onPayload?.(payload, model);
        captures.push({
          system: context.systemPrompt,
          messages: structuredClone(context.messages),
          payload: transformed ?? payload,
        });
        payload_ready?.();
        await payload_release;
        throw new Error("request captured before network");
      },
    });
  return session;
}

function notifications(session: (typeof sessions)[number]) {
  return session.messages.filter(
    (message: any) =>
      message.role === "custom" && message.details?.kind === "model-change",
  );
}

/** The `from → to` pairs of the model-change notices the last request sent. */
function payload_model_changes(captures: { messages: any[] }[]): string[] {
  const pairs: string[] = [];
  for (const message of captures.at(-1)?.messages ?? []) {
    const parts = Array.isArray(message.content)
      ? message.content
      : [message.content];
    for (const part of parts) {
      const text = typeof part === "string" ? part : (part?.text ?? "");
      for (const match of text.matchAll(
        /<from>([^<]+)<\/from>\s*<to>([^<]+)<\/to>/g,
      ))
        pairs.push(`${match[1]} → ${match[2]}`);
    }
  }
  return pairs;
}

try {
  const manager = SessionManager.create(root, join(root, "sessions"));
  const session = await open(manager);
  await session.setModel(base);
  const initial_count = notifications(session).length;
  await session.prompt("initial capture");
  const original = captures.at(-1).system;
  assert(original.includes(`currently powered by **\`${provider}/base\`**`));
  const first_leaf = manager.getLeafId()!;
  await session.setModel(fast);
  await session.setModel(fast);
  assert.equal(session.isStreaming, false);
  assert.equal(notifications(session).length, initial_count);
  await session.prompt("after model switch");
  assert.equal(notifications(session).length, initial_count + 1);
  assert.equal(captures.at(-1).system, original);
  assert.equal(captures.at(-1).payload.model, "base-fast");
  assert(
    JSON.stringify(captures.at(-1).messages).includes(
      'notification type=\\"model-change\\"',
    ),
  );
  assert(
    JSON.stringify(captures.at(-1).messages).includes(`${provider}/base-fast`),
  );
  assert.equal((notifications(session).at(-1) as any).display, false);

  await session.prompt("settled notice is not repeated");
  assert.equal(notifications(session).length, initial_count + 1);

  await session.reload();
  assert.equal(notifications(session).length, initial_count + 1);
  await session.prompt("after extension reload");
  assert.equal(notifications(session).length, initial_count + 1);
  assert.equal(captures.at(-1).system, original);
  const reopened = await open(SessionManager.open(manager.getSessionFile()!));
  assert.equal(reopened.model?.id, "base-fast");
  assert.equal(notifications(reopened).length, initial_count + 1);
  await reopened.prompt("after resume");
  assert.equal(captures.at(-1).system, original);

  const settled = notifications(session).length;
  for (const model of [base, mid_a, mid_b, base, mid_a])
    await session.setModel(model);
  assert.equal(notifications(session).length, settled);
  await session.prompt("burst settling elsewhere");
  assert.equal(notifications(session).length, settled + 1);
  assert.deepEqual((notifications(session).at(-1) as any).details.payload, {
    from: `${provider}/base-fast`,
    to: `${provider}/mid-a`,
  });
  assert.deepEqual(payload_model_changes(captures), [
    `${provider}/base → ${provider}/base-fast`,
    `${provider}/base-fast → ${provider}/mid-a`,
  ]);

  for (const model of [
    mid_b,
    base,
    mid_a,
    mid_b,
    base,
    mid_a,
    mid_b,
    base,
    mid_b,
  ])
    await session.setModel(model);
  await session.prompt("burst cycling past the represented model");
  assert.equal(notifications(session).length, settled + 2);
  assert.deepEqual((notifications(session).at(-1) as any).details.payload, {
    from: `${provider}/mid-a`,
    to: `${provider}/mid-b`,
  });
  assert.deepEqual(payload_model_changes(captures), [
    `${provider}/base → ${provider}/base-fast`,
    `${provider}/base-fast → ${provider}/mid-a`,
    `${provider}/mid-a → ${provider}/mid-b`,
  ]);

  for (const model of [base, mid_a, mid_b]) await session.setModel(model);
  await session.prompt("burst returning to the represented model");
  assert.equal(notifications(session).length, settled + 2);
  assert.equal(payload_model_changes(captures).length, 3);

  await session.navigateTree(first_leaf, { summarize: false });
  assert.equal(notifications(session).length, initial_count);
  await session.setModel(base);
  await session.prompt("on restored branch");
  assert.equal(captures.at(-1).system, original);
  assert.equal(notifications(session).length, initial_count);
  await session.setModel(fast);
  await session.prompt("switch on restored branch");
  assert.equal(notifications(session).length, initial_count + 1);

  let release!: () => void;
  payload_release = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    payload_ready = resolve;
  });
  const pending = session.prompt("switch during streaming");
  await ready;
  await session.setModel(base);
  assert.equal(notifications(session).length, initial_count + 1);
  release();
  await pending;
  payload_release = undefined;
  payload_ready = undefined;
  assert.equal(session.isStreaming, false);
  assert.equal(notifications(session).length, initial_count + 1);
  await session.prompt("after streaming switch");
  assert.equal(captures.at(-1).system, original);
  assert.equal(notifications(session).length, initial_count + 2);
  assert.deepEqual(payload_model_changes(captures), [
    `${provider}/base → ${provider}/base-fast`,
    `${provider}/base-fast → ${provider}/base`,
  ]);

  await session.setModel(fast);
  await session.navigateTree(manager.getEntries()[0].id, { summarize: false });
  await session.prompt("rewound before the origin entry");
  assert.equal(captures.at(-1).system, original);
  const repaired = captures
    .at(-1)
    .messages.filter((message: any) =>
      JSON.stringify(message.content).includes(
        'notification type=\\"model-change\\"',
      ),
    );
  assert.equal(repaired.length, 1);
  assert(JSON.stringify(repaired).includes(`${provider}/base-fast`));
  const repaired_count = notifications(session).length;
  await session.reload();
  await session.prompt("same rewound model after reload");
  assert.equal(notifications(session).length, repaired_count);
  assert.equal(
    captures
      .at(-1)
      .messages.filter((message: any) =>
        JSON.stringify(message.content).includes(
          'notification type=\\"model-change\\"',
        ),
      ).length,
    1,
  );

  const minimal = await open(SessionManager.inMemory(root), true);
  await minimal.setModel(base);
  const minimal_count = notifications(minimal).length;
  await minimal.setModel(fast);
  assert.equal(notifications(minimal).length, minimal_count);
  await minimal.prompt("minimal session notification");
  assert.equal(notifications(minimal).length, minimal_count + 1);
  assert(
    JSON.stringify(captures.at(-1).messages).includes(`${provider}/base-fast`),
  );
  assert.deepEqual(errors, []);
  console.log(
    "model context: request-time notices, burst coalescing, no-ops, reload, resume, branch, streaming, minimal session passed",
  );
} finally {
  for (const session of sessions) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  rmSync(root, { recursive: true, force: true });
}
