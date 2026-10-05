import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
    env: { PI_OFFLINE: "1" },
    reporters: ["dot"],
  },
});
