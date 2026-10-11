import "@cpi/cli/bootstrap";
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { buildShellEnvWithDotenv } from "../shell/tools.ts";
import { subagentEnvironment } from "./activity-subagent.ts";
import { hostCodingAgent } from "../../bin/host-pi.mjs";

const sourceSdk = await hostCodingAgent();
const source = {
  CPI_APP_SDK_URL: process.env.CPI_APP_SDK_URL,
  CPI_HOST_SDK_URL: process.env.CPI_HOST_SDK_URL,
  CPI_HOST_AI_URL: process.env.CPI_HOST_AI_URL,
  CPI_HOST_TUI_URL: process.env.CPI_HOST_TUI_URL,
  CPI_HOST_ROOT: sourceSdk.getPackageDir(),
  CPI_HOST_CLI: process.env.CPI_HOST_CLI,
  CPI_FORK: process.env.CPI_FORK,
  JITI_ALIAS: process.env.JITI_ALIAS,
  PI_APPLICATION_MANIFEST: process.env.PI_APPLICATION_MANIFEST,
};
const installedSdkUrl = new URL(
  "../../../../node_modules/@earendil-works/pi-coding-agent/dist/index.js",
  import.meta.url,
).href;
const installed = {
  ...source,
  CPI_APP_SDK_URL: installedSdkUrl,
  CPI_HOST_SDK_URL: installedSdkUrl,
  CPI_HOST_AI_URL: new URL(
    "../../../../node_modules/@earendil-works/pi-ai/dist/compat.js",
    import.meta.url,
  ).href,
  CPI_HOST_TUI_URL: new URL(
    "../../../../node_modules/@earendil-works/pi-tui/dist/index.js",
    import.meta.url,
  ).href,
  CPI_HOST_ROOT: fileURLToPath(
    new URL(
      "../../../../node_modules/@earendil-works/pi-coding-agent",
      import.meta.url,
    ),
  ),
  CPI_FORK: undefined,
  JITI_ALIAS: undefined,
};

async function loadInWorker(env: NodeJS.ProcessEnv) {
  const worker = new Worker(
    new URL(
      `data:text/javascript,${encodeURIComponent(`
import { parentPort } from "node:worker_threads";
import { hostCodingAgent, hostAi, hostTui } from ${JSON.stringify(new URL("../../bin/host-pi.mjs", import.meta.url).href)};
const sdk = await hostCodingAgent();
const ai = await hostAi();
const tui = await hostTui();
parentPort.postMessage({
  name: sdk.APP_NAME,
  root: sdk.getPackageDir(),
  model: ai.getModel("openai", "gpt-4o").id,
  width: tui.visibleWidth("hello"),
});
`)}`,
    ),
    { env },
  );
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Host loader timed out")),
        20_000,
      );
      worker.once("message", (value) => {
        clearTimeout(timeout);
        resolve(value);
      });
      worker.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Host loader exited ${code} without a result`));
      });
    });
  } finally {
    await worker.terminate();
  }
}

for (const [name, active] of [
  ["source fork", source],
  ["installed SDK", installed],
] as const) {
  test(`${name} routing overrides captured dotenv and stale subagent requests`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cpi-host-routing-"));
    const previous = new Map(
      Object.keys(active).map((key) => [key, process.env[key]]),
    );
    try {
      for (const [key, value] of Object.entries(active)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const stale = Object.fromEntries(
        Object.keys(active).map((key) => [key, "/missing/stale-host"]),
      );
      const envPath = join(directory, "captured.env");
      await writeFile(
        envPath,
        Object.entries({
          ...stale,
          USER_CAPTURE: "captured",
          CPI_USER_SETTING: "ordinary",
          PATH: "/captured/bin",
        })
          .map(([key, value]) => `${key}=${value}`)
          .join("\n"),
      );
      const shell = buildShellEnvWithDotenv(undefined, envPath);
      const request = {
        version: 1 as const,
        argv: [],
        task: "unused",
        cwd: directory,
        runId: "host-routing-regression",
        env: { ...stale, USER_CAPTURE: "request", CPI_USER_SETTING: "request" },
      };
      const worker = subagentEnvironment(request, "/current/rpc");
      for (const [key, value] of Object.entries(active)) {
        expect(shell[key]).toBe(value);
        expect(worker[key]).toBe(value);
        if (value === undefined) {
          expect(Object.hasOwn(shell, key)).toBe(false);
          expect(Object.hasOwn(worker, key)).toBe(false);
        }
      }
      expect(shell.USER_CAPTURE).toBe("captured");
      expect(shell.CPI_USER_SETTING).toBe("ordinary");
      expect(shell.PATH?.split(delimiter).at(-1)).toBe("/captured/bin");
      expect(worker.USER_CAPTURE).toBe("request");
      expect(worker.CPI_USER_SETTING).toBe("request");
      expect(worker.CPI_SUBAGENT_RPC).toBe("/current/rpc");
      expect(request.env).toEqual({
        ...stale,
        USER_CAPTURE: "request",
        CPI_USER_SETTING: "request",
      });
      for (const env of [shell, worker]) {
        expect(await loadInWorker(env)).toEqual({
          name: "cpi",
          root: active.CPI_HOST_ROOT,
          model: "gpt-4o",
          width: 5,
        });
      }
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
}
