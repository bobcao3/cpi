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
const models = ["base", "base-fast"].map((id) => ({
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
assert(base && fast);
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

try {
  const manager = SessionManager.create(root, join(root, "sessions"));
  const session = await open(manager);
  await session.setModel(base);
  const initial_count = notifications(session).length;
  await session.prompt("initial capture");
  const original = captures.at(-1).system;
  assert(
    original.includes(
      `initial model for this session is **\`${provider}/base\`**`,
    ),
  );
  const first_leaf = manager.getLeafId()!;
  await session.setModel(fast);
  assert.equal(notifications(session).length, initial_count + 1);
  assert.equal(session.isStreaming, false);
  await session.setModel(fast);
  assert.equal(notifications(session).length, initial_count + 1);
  await session.prompt("after model switch");
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

  await session.reload();
  assert.equal(notifications(session).length, initial_count + 1);
  await session.prompt("after extension reload");
  assert.equal(captures.at(-1).system, original);
  const reopened = await open(SessionManager.open(manager.getSessionFile()!));
  assert.equal(reopened.model?.id, "base-fast");
  assert.equal(notifications(reopened).length, initial_count + 1);
  await reopened.prompt("after resume");
  assert.equal(captures.at(-1).system, original);

  await session.navigateTree(first_leaf, { summarize: false });
  assert.equal(session.model?.id, "base-fast");
  assert.equal(notifications(session).length, initial_count);
  await session.setModel(base);
  await session.prompt("on restored branch");
  assert.equal(captures.at(-1).system, original);
  await session.setModel(fast);
  assert.equal(notifications(session).length, initial_count + 2);

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
  assert.equal(notifications(session).length, initial_count + 2);
  release();
  await pending;
  payload_release = undefined;
  payload_ready = undefined;
  assert.equal(notifications(session).length, initial_count + 3);
  assert.equal(session.isStreaming, false);
  await session.prompt("after streaming switch");
  assert.equal(captures.at(-1).system, original);
  assert(JSON.stringify(captures.at(-1).messages).includes(`${provider}/base`));

  await session.setModel(fast);
  await session.navigateTree(manager.getEntries()[0].id, { summarize: false });
  await session.prompt("rewound before the origin entry");
  assert.equal(captures.at(-1).system, original);
  assert.equal(
    (notifications(session).at(-1) as any)?.details.payload.to,
    `${provider}/base-fast`,
  );
  const repaired_count = notifications(session).length;
  await session.reload();
  await session.prompt("same rewound model after reload");
  assert.equal(notifications(session).length, repaired_count);

  const minimal = await open(SessionManager.inMemory(root), true);
  await minimal.setModel(base);
  const minimal_count = notifications(minimal).length;
  await minimal.setModel(fast);
  assert.equal(notifications(minimal).length, minimal_count + 1);
  await minimal.prompt("minimal session notification");
  assert(
    JSON.stringify(captures.at(-1).messages).includes(`${provider}/base-fast`),
  );
  assert.deepEqual(errors, []);
  console.log(
    "model context: stable prompt, persisted notifications, no-ops, reload, resume, branch, streaming, minimal session passed",
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
