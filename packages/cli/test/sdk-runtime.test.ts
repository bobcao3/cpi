import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "vitest";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const probe = join(repository, "packages/cli/test/sdk-route-probe.ts");
const fork = join(repository, ".pi-fork");

for (const mode of [
  "native",
  "bootstrap-native",
  "cli",
  "explicit-cli",
  "explicit-native",
] as const) {
  test(`${mode} SDK and host helpers share the active Pi runtime`, () => {
    const temporary = mkdtempSync(join(tmpdir(), "cpi-sdk-route-"));
    const resultPath = join(temporary, "result.json");
    const env = { ...process.env };
    for (const name of Object.keys(env)) {
      if (name.startsWith("CPI_") || name.startsWith("JITI_")) delete env[name];
    }
    Object.assign(env, {
      CPI_ROUTE_RESULT: resultPath,
      PI_CODING_AGENT_DIR: temporary,
      PI_OFFLINE: "1",
    });
    if (mode.startsWith("explicit-")) env.CPI_FORK = fork;
    if (mode === "bootstrap-native") env.CPI_ROUTE_BOOTSTRAP = "1";
    try {
      const args = mode.endsWith("native")
        ? [probe]
        : [
            join(repository, "packages/cli/bin/cpi.mjs"),
            "--mode",
            "rpc",
            "--no-extensions",
            "--no-skills",
            "--no-themes",
            "--no-context-files",
            "--no-prompt-templates",
            "--no-session",
            "-e",
            probe,
          ];
      const child = spawnSync(process.execPath, args, {
        cwd: temporary,
        env,
        input: "",
        encoding: "utf8",
        timeout: 25000,
      });
      expect(child.error, child.stderr).toBeUndefined();
      if (mode === "explicit-native") {
        expect(child.status).toBe(1);
        expect(child.stderr).toContain(
          "CPI_FORK does not match the active Pi runtime",
        );
        expect(existsSync(resultPath)).toBe(false);
        return;
      }
      expect(child.status, child.stderr).toBe(0);
      const result = JSON.parse(readFileSync(resultPath, "utf8"));
      const expectedRoot = mode.endsWith("native")
        ? dirname(
            dirname(
              fileURLToPath(
                import.meta.resolve("@earendil-works/pi-coding-agent"),
              ),
            ),
          )
        : join(fork, "packages/coding-agent");
      expect(realpathSync(result.root)).toBe(realpathSync(expectedRoot));
      if (!mode.endsWith("native")) {
        expect(result.sdk).toBe(
          pathToFileURL(join(fork, "packages/coding-agent/src/index.ts")).href,
        );
        expect(result.ai).toBe(
          pathToFileURL(join(fork, "packages/ai/src/compat.ts")).href,
        );
        expect(result.tui).toBe(
          pathToFileURL(join(fork, "packages/tui/src/index.ts")).href,
        );
      }
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
