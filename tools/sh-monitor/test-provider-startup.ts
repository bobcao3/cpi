import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { setCwd } from "../../extensions/lib/cwd.ts";

const root = mkdtempSync(join(tmpdir(), "cpi-provider-startup-"));
const originalHome = process.env.HOME;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const sessions: Awaited<ReturnType<typeof createAgentSession>>["session"][] =
  [];
const configure = (ids: string[], baseUrl = "http://127.0.0.1:1/v1") => {
  writeFileSync(
    join(root, ".pi", "fallback-providers.json"),
    JSON.stringify({
      providers: ids.length
        ? {
            "probe-llm": {
              baseUrl,
              api: "openai-completions",
              apiKey: "NO",
              models: ids.map((id) => ({
                id,
                contextWindow: 8192,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              })),
            },
          }
        : {},
    }),
  );
};
const open = async () => {
  const runtime = await ModelRuntime.create({
    modelsPath: join(root, `models-${sessions.length}.json`),
    authPath: join(root, `auth-${sessions.length}.json`),
  });
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    additionalExtensionPaths: [resolve("extensions/provider.ts")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelIds = ["probe-model", "probe-model-2"];
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: runtime,
    noTools: "all",
  });
  sessions.push(session);
  for (const id of modelIds) assert(runtime.getModel("probe-llm", id));
  const errors: string[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error.error),
  });
  assert.deepEqual(errors, []);
  for (const id of modelIds) assert(runtime.getModel("probe-llm", id));
  return { runtime, session, errors };
};
try {
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = root;
  setCwd(root);
  mkdirSync(join(root, ".pi"));
  configure(["probe-model", "probe-model-2"]);
  const first = await open();
  const second = await open();
  configure(["replacement-model"], "http://127.0.0.1:2/v1");
  await first.session.reload();
  assert.deepEqual(first.errors, []);
  assert.equal(first.runtime.getModel("probe-llm", "probe-model"), undefined);
  assert.equal(first.runtime.getModel("probe-llm", "probe-model-2"), undefined);
  assert.equal(
    first.runtime.getModel("probe-llm", "replacement-model")?.baseUrl,
    "http://127.0.0.1:2/v1",
  );
  assert(second.runtime.getModel("probe-llm", "probe-model"));
  assert(second.runtime.getModel("probe-llm", "probe-model-2"));
  await second.session.reload();
  assert.deepEqual(second.errors, []);
  assert.equal(second.runtime.getModel("probe-llm", "probe-model"), undefined);
  assert.equal(
    second.runtime.getModel("probe-llm", "replacement-model")?.baseUrl,
    "http://127.0.0.1:2/v1",
  );
  configure([]);
  await first.session.reload();
  assert.deepEqual(first.errors, []);
  assert.equal(
    first.runtime.getModel("probe-llm", "replacement-model"),
    undefined,
  );
  assert(second.runtime.getModel("probe-llm", "replacement-model"));
  console.log("provider lifecycle: runtime reload isolation verified");
} finally {
  for (const session of sessions) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  setCwd(process.cwd());
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  rmSync(root, { recursive: true, force: true });
}
