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
const originalToken = process.env.CPI_PROBE_TOKEN;
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
try {
  process.env.HOME = root;
  process.env.CPI_PROBE_TOKEN = "present";
  setCwd(root);
  mkdirSync(join(root, ".pi"));
  writeFileSync(
    join(root, ".pi", "fallback-providers.json"),
    JSON.stringify({
      providers: {
        "strip-probe": {
          baseUrl: "http://127.0.0.1:1/v1",
          api: "openai-completions",
          apiKey: "NO",
          models: ["test-model", "gpt-5.3", "gpt-5.6"].map((id) => ({
            id,
            contextWindow: 8192,
            maxTokens: 1024,
          })),
        },
      },
      strip: [{ provider: "strip-probe", env: ["CPI_PROBE_TOKEN"] }],
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
  assert(runtime.getModel("strip-probe", "test-model"));
  assert(runtime.getModel("strip-probe", "gpt-5.6"));
  assert.equal(runtime.getModel("strip-probe", "gpt-5.3"), undefined);
  console.log("provider startup: provider kept, superseded model stripped");
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
  if (originalToken === undefined) delete process.env.CPI_PROBE_TOKEN;
  else process.env.CPI_PROBE_TOKEN = originalToken;
  rmSync(root, { recursive: true, force: true });
}
