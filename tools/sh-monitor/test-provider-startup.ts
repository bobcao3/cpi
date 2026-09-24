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
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
try {
  process.env.HOME = root;
  setCwd(root);
  mkdirSync(join(root, ".pi"));
  writeFileSync(
    join(root, ".pi", "fallback-providers.json"),
    JSON.stringify({
      providers: {
        "probe-llm": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "NO",
          models: ["probe-model", "probe-model-2"].map((id) => ({
            id,
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
    }),
  );
  const runtime = await ModelRuntime.create({
    modelsPath: join(root, "models.json"),
    authPath: join(root, "auth.json"),
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
  ({ session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    settingsManager: settings,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(root),
    modelRuntime: runtime,
    noTools: "all",
  }));
  const errors: string[] = [];
  await session.bindExtensions({
    mode: "print",
    onError: (error) => errors.push(error.error),
  });
  assert.deepEqual(errors, []);
  assert(runtime.getModel("probe-llm", "probe-model"));
  assert(runtime.getModel("probe-llm", "probe-model-2"));
  console.log("provider startup: configured provider registered");
} finally {
  if (session) {
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session.dispose();
  }
  setCwd(process.cwd());
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(root, { recursive: true, force: true });
}
