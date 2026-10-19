import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { forkDir, isForkCheckout } from "../../scripts/fork.mjs";

// Select the same editable fork as scripts/check.mjs; otherwise test installed Pi.
const fork = isForkCheckout(forkDir()) ? forkDir() : undefined;
const paths: Record<string, string[]> = fork
  ? JSON.parse(readFileSync(join(fork, "tsconfig.json"), "utf8"))
      .compilerOptions.paths
  : {};

export default defineConfig({
  resolve: {
    tsconfigPaths: fork !== undefined,
    alias: Object.entries(paths)
      .filter(([name]) => !name.includes("*"))
      .map(([name, [target]]) => ({
        find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        replacement: resolve(fork, target),
      })),
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    env: { PI_OFFLINE: "1" },
    reporters: ["dot"],
  },
});
