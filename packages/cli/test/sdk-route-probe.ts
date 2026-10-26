import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

export default async function verifyRoutes() {
  if (process.env.CPI_ROUTE_BOOTSTRAP === "1") {
    await import("../bootstrap.mjs");
    const { hostCodingAgent } = await import("../../harness/bin/host-pi.mjs");
    await hostCodingAgent();
  }
  const sdk = await import("../src/index.ts");
  const loader = new sdk.DefaultResourceLoader({
    cwd: process.cwd(),
    agentDir: process.env.PI_CODING_AGENT_DIR!,
    settingsManager: sdk.SettingsManager.inMemory(),
    noSkills: true,
    noThemes: true,
    noContextFiles: true,
    noPromptTemplates: true,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  for (const name of ["search_query", "web_fetch"]) {
    const tools = loaded.extensions.flatMap((extension) => {
      const tool = extension.tools.get(name);
      return tool ? [tool.definition] : [];
    });
    assert.equal(tools.length, 1, `${name} must be registered once by default`);
    assert.equal(tools[0].exposure, "codemode");
  }
  const before = process.env.CPI_HOST_ROOT;
  const { hostCodingAgent, hostAi, hostTui } =
    await import("../../harness/bin/host-pi.mjs");
  const host = await hostCodingAgent();
  assert.equal(host.getPackageDir(), sdk.getPackageDir());
  assert.equal(process.env.CPI_HOST_ROOT, before);
  assert.equal(host.SessionManager, sdk.SessionManager);
  assert.ok(sdk.SessionManager.inMemory() instanceof host.SessionManager);
  const ai = await import("@earendil-works/pi-ai/compat");
  const tui = await import("@earendil-works/pi-tui");
  assert.equal((await hostAi()).getModel, ai.getModel);
  assert.equal((await hostTui()).Text, tui.Text);
  const result = {
    root: sdk.getPackageDir(),
    sdk: process.env.CPI_HOST_SDK_URL,
    ai: process.env.CPI_HOST_AI_URL,
    tui: process.env.CPI_HOST_TUI_URL,
  };
  writeFileSync(process.env.CPI_ROUTE_RESULT!, JSON.stringify(result));
}

if (process.argv[1]?.endsWith("sdk-route-probe.ts")) await verifyRoutes();
