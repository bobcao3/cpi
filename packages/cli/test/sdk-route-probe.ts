import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

export default async function verifyRoutes() {
  if (process.env.CPI_ROUTE_BOOTSTRAP === "1") {
    await import("../bootstrap.mjs");
    const { hostCodingAgent } = await import("../../harness/bin/host-pi.mjs");
    await hostCodingAgent();
  }
  const sdk = await import("../src/index.ts");
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
