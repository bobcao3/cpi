import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { resolveTreeSitterWasm } from "./resolve.ts";
import { stage_wasm } from "./scripts/package-api.mjs";
import {
  execute,
  install,
  pack,
  registry,
} from "../../scripts/package-test.mjs";

test(
  "npm and Bun install self-contained signed WASM and run production parsers",
  { timeout: 300000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cpi-wasm-installed-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const artifact = process.env.CPI_TREE_SITTER_TEST_ARTIFACT
      ? join(process.env.CPI_TREE_SITTER_TEST_ARTIFACT, "tree-sitter-wasm.wasm")
      : await resolveTreeSitterWasm();
    const staged = join(directory, "package");
    await stage_wasm(staged, artifact);
    const server = await registry([
      { directory: staged, archive: pack(staged, directory) },
    ]);
    try {
      for (const manager of ["npm", "bun"]) {
        const consumer = join(directory, manager);
        await install(manager, consumer, "@cpi/tree-sitter-wasm", server.url);
        const installed = join(consumer, "node_modules/@cpi/tree-sitter-wasm");
        const runner = join(consumer, "installed-probe.mjs");
        await copyFile(
          fileURLToPath(new URL("./installed-probe.mjs", import.meta.url)),
          runner,
        );
        const bundled = join(installed, "assets/tree-sitter-wasm.wasm");
        const environment = {
          ...process.env,
          CPI_TS_WASM: "",
          PATH: "",
          HTTP_PROXY: "http://127.0.0.1:1",
          HTTPS_PROXY: "http://127.0.0.1:1",
        };
        execute(process.execPath, [runner, bundled], { env: environment });
        const bytes = await readFile(bundled);
        bytes[bytes.length - 1] ^= 1;
        await writeFile(bundled, bytes);
        const failed = () => {
          const result = spawnSync(process.execPath, [runner, bundled], {
            env: environment,
            encoding: "utf8",
            timeout: 10000,
          });
          assert.notEqual(result.status, 0);
          return result.stderr;
        };
        assert.match(failed(), /signature verification failed/);
        await rm(bundled);
        assert.match(failed(), /Missing packaged tree-sitter WASM/);
      }
    } finally {
      await server.close();
    }
  },
);
